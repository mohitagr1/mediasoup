const config = require('./config');
const fs = require('fs');
const mediasoup = require('mediasoup');
const express = require('express');
const https = require('https');

const expressApp = express();
// const server = require('http').createServer(expressApp);
const socketIO = require('socket.io');
let httpsServer;
let worker, router, audioLevelObserver;

// const log = debugModule('demo-app');
// const warn = debugModule('demo-app:WARN');
// const err = debugModule('demo-app:ERROR');


const roomState = {
    // external
    peers: {},
    activeSpeaker: { producerId: null, volume: null, peerId: null },
    // internal
    transports: {},
    producers: [],
    consumers: []
}

expressApp.use(express.json());
expressApp.use(express.static(__dirname));

async function main() {
    console.log('starting mediasoup');
    ({ worker, router, audioLevelObserver } = await startMediaSoup());

    console.log('starting express');
    startExpress();

    await runSocketServer();

    setInterval(periodicCleanUp, 1000);

    setInterval(updatePeerStats, 3000);
}

main();

async function runSocketServer() {
    let socketServer = socketIO(httpsServer, {
        serveClient: false,
        path: '/server',
        log: false,
    });

    socketServer.on('connection', (socket) => {
        console.log('client connected');

        socket.on('joinAsNewPeer', async (data, callback) => {
            try {
                let { myPeerId } = data;
                let peerId = myPeerId;
                let now = Date.now();
                console.log('join-as-new-peer', peerId);

                roomState.peers[peerId] = {
                    joinTs: now,
                    lastSeenTs: now,
                    media: {}, consumerLayers: {}, stats: {}
                };

                console.log(`Initail room state `, roomState);

                callback(router.rtpCapabilities);
            } catch (e) {
                console.error('error in /signaling/join-as-new-peer', e);
                callback({ error: e });
            }
        });

        socket.on('leave', async (data, callback) => {
            try {
                let { peerId } = data;
                console.log('leave', peerId);

                await closePeer(peerId);
                callback({ left: true });
            } catch (e) {
                console.error('error in /signaling/leave', e);
                callback({ error: e });
            }
        });

        socket.on('createTransport', async (data, callback) => {
            try {
                let { myPeerId, direction } = data;
                let peerId = myPeerId;
                console.log(`createTransport`, peerId, direction);

                let transport = await createWebRtcTransport({ peerId, direction });
                roomState.transports[transport.id] = transport;

                let { id, iceParameters, iceCandidates, dtlsParameters } = transport;
                callback({
                    transportOptions: { id, iceParameters, iceCandidates, dtlsParameters }
                })
            } catch (error) {
                console.log(`error in server createTransport`, error);
            }
        });

        socket.on('connectTransport', async (data, callback) => {
            try {
                let { myPeerId, transportId, dtlsParameters } = data;
                let peerId = myPeerId;
                console.log(`connectTransport`, peerId);
                let transport = roomState.transports[transportId];

                if (!transport) {
                    console.log(`connect-transport: server-side transport ${transportId} not found`);
                    callback({ error: `server-side transport ${transportId} not found` });
                    return;
                }

                console.log('connect-transport', peerId, transport.appData);

                await transport.connect({ dtlsParameters });
                callback({ connected: true });
            } catch (e) {
                console.error('error in /signaling/connect-transport', e);
                callback({ error: e });
            }
        });

        socket.on('closeTransport', async (data, callback) => {
            try {
                let { myPeerId, transportId } = data;
                let peerId = myPeerId;
                let transport = roomState.transports[transportId];

                if (!transport) {
                    console.log(`close-transport: server-side transport ${transportId} not found`);
                    callback({ error: `server-side transport ${transportId} not found` });
                    return;
                }

                console.log('close-transport', peerId, transport.appData);

                await closeTransport(transport);
                callback({ closed: true });
            } catch (e) {
                console.log(`error in close transport`, e);
            }
        });

        socket.on('closeProducer', async (data, callback) => {
            try {
                let { myPeerId, producerId } = data;
                let peerId = myPeerId;
                let producer = roomState.producers.find((p) => p.id === producerId);

                if (!producer) {
                    console.log(`close-producer: server-side producer ${producerId} not found`);
                    callback({ error: `server-side producer ${producerId} not found` });
                    return;
                }

                console.log('close-producer', peerId, producer.appData);

                await closeProducer(producer);
                callback({ closed: true });
            } catch (e) {
                console.error(e);
                callback({ error: e.message });
            }
        });

        socket.on('sendTrack', async (data, callback) => {
            try {
                let { myPeerId, transportId, kind, rtpParameters,
                    paused = false, appData } = data;
                let peerId = myPeerId;
                let transport = roomState.transports[transportId];

                console.log(`data from sendTrack`, peerId, transportId, kind, rtpParameters, paused, appData);

                if (!transport) {
                    console.log(`send-track: server-side transport ${transportId} not found`);
                    callback({ error: `server-side transport ${transportId} not found` });
                    return;
                }

                let producer = await transport.produce({
                    kind,
                    rtpParameters,
                    paused,
                    appData: { ...appData, peerId, transportId }
                });
                console.log(`in sendTrack`, producer);
                // if our associated transport closes, close ourself, too
                producer.on('transportclose', () => {
                    console.log('producer\'s transport closed', producer.id);
                    closeProducer(producer);
                });

                // monitor audio level of this producer. we call addProducer() here,
                // but we don't ever need to call removeProducer() because the core
                // AudioLevelObserver code automatically removes closed producers
                if (producer.kind === 'audio') {
                    audioLevelObserver.addProducer({ producerId: producer.id });
                }

                roomState.producers.push(producer);
                console.log(roomState);
                roomState.peers[peerId].media[appData.mediaTag] = {
                    paused,
                    encodings: rtpParameters.encodings
                };

                callback({ id: producer.id });
            } catch (e) {
                console.log(`error in socket.io sendTrack`, e);
            }
        });

        socket.on('recvTrack', async (data, callback) => {
            try {
                let { peerId, mediaPeerId, mediaTag, rtpCapabilities } = data;

                let producer = roomState.producers.find(
                    (p) => p.appData.mediaTag === mediaTag &&
                        p.appData.peerId === mediaPeerId
                );

                if (!producer) {
                    let msg = 'server-side producer for ' +
                        `${mediaPeerId}:${mediaTag} not found`;
                    console.log('recv-track: ' + msg);
                    callback({ error: msg });
                    return;
                }

                if (!router.canConsume({
                    producerId: producer.id,
                    rtpCapabilities
                })) {
                    let msg = `client cannot consume ${mediaPeerId}:${mediaTag}`;
                    console.log(`recv-track: ${peerId} ${msg}`);
                    callback({ error: msg });
                    return;
                }

                let transport = Object.values(roomState.transports).find((t) =>
                    t.appData.peerId === peerId && t.appData.clientDirection === 'recv'
                );

                if (!transport) {
                    let msg = `server-side recv transport for ${peerId} not found`;
                    console.log('recv-track: ' + msg);
                    callback({ error: msg });
                    return;
                }

                let consumer = await transport.consume({
                    producerId: producer.id,
                    rtpCapabilities,
                    paused: true, // see note above about always starting paused
                    appData: { peerId, mediaPeerId, mediaTag }
                });

                // need both 'transportclose' and 'producerclose' event handlers,
                // to make sure we close and clean up consumers in all
                // circumstances
                consumer.on('transportclose', () => {
                    console.log(`consumer's transport closed`, consumer.id);
                    closeConsumer(consumer);
                });
                consumer.on('producerclose', () => {
                    console.log(`consumer's producer closed`, consumer.id);
                    closeConsumer(consumer);
                });

                // stick this consumer in our list of consumers to keep track of,
                // and create a data structure to track the client-relevant state
                // of this consumer
                roomState.consumers.push(consumer);
                roomState.peers[peerId].consumerLayers[consumer.id] = {
                    currentLayer: null,
                    clientSelectedLayer: null
                };

                // update above data structure when layer changes.
                consumer.on('layerschange', (layers) => {
                    console.log(`consumer layerschange ${mediaPeerId}->${peerId}`, mediaTag, layers);
                    if (roomState.peers[peerId] &&
                        roomState.peers[peerId].consumerLayers[consumer.id]) {
                        roomState.peers[peerId].consumerLayers[consumer.id]
                            .currentLayer = layers && layers.spatialLayer;
                    }
                });

                callback({
                    producerId: producer.id,
                    id: consumer.id,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                    type: consumer.type,
                    producerPaused: consumer.producerPaused
                });
            } catch (e) {
                console.error('error in /signaling/recv-track', e);
                callback({ error: e });
            }
        });

        socket.on('closeConsumer', async (data, callback) => {
            try {
                let { consumerId } = data,
                    consumer = roomState.consumers.find((c) => c.id === consumerId);

                if (!consumer) {
                    console.log(`close-consumer: server-side consumer ${consumerId} not found`);
                    callback({ error: `server-side consumer ${consumerId} not found` });
                    return;
                }

                await closeConsumer(consumer);

                callback({ closed: true });
            } catch (e) {
                console.error('error in /signaling/close-consumer', e);
                callback({ error: e });
            }
        });


        socket.on('consumerSetLayers', async (data, callback) => {
            try {
                let { consumerId, spatialLayer } = data,
                    consumer = roomState.consumers.find((c) => c.id === consumerId);

                if (!consumer) {
                    console.log(`consumer-set-layers: server-side consumer ${consumerId} not found`);
                    callback({ error: `server-side consumer ${consumerId} not found` });
                    return;
                }

                console.log('consumer-set-layers', spatialLayer, consumer.appData);

                await consumer.setPreferredLayers({ spatialLayer });

                callback({ layersSet: true });
            } catch (e) {
                console.error('error in /signaling/consumer-set-layers', e);
                callback({ error: e });
            }
        });


        socket.on('pauseProducer', async (data, callback) => {
            try {
                let { myPeerId, producerId } = data;
                let peerId = myPeerId;
                let producer = roomState.producers.find((p) => p.id === producerId);

                if (!producer) {
                    console.log(`pause-producer: server-side producer ${producerId} not found`);
                    callback({ error: `server-side producer ${producerId} not found` });
                    return;
                }

                console.log('pause-producer', producer.appData);

                await producer.pause();

                roomState.peers[peerId].media[producer.appData.mediaTag].paused = true;

                callback({ paused: true });
            } catch (e) {
                console.error('error in /signaling/pause-producer', e);
                callback({ error: e });
            }
        });


        socket.on('resumeProducer', async (data, callback) => {
            try {
                let { myPeerId, producerId } = data;
                let peerId = myPeerId;
                let producer = roomState.producers.find((p) => p.id === producerId);

                if (!producer) {
                    console.log(`resume-producer: server-side producer ${producerId} not found`);
                    callback({ error: `server-side producer ${producerId} not found` });
                    return;
                }

                console.log('resume-producer', producer.appData);

                await producer.resume();

                roomState.peers[peerId].media[producer.appData.mediaTag].paused = false;

                callback({ resumed: true });
            } catch (e) {
                console.error('error in /signaling/resume-producer', e);
                callback({ error: e });
            }
        });



        socket.on('sync', async (data, callback) => {
            try {
                let { myPeerId } = data;
                let peerId = myPeerId;
                // make sure this peer is connected. if we've disconnected the
                // peer because of a network outage we want the peer to know that
                // happened, when/if it returns
                if (!roomState.peers[peerId]) {
                    throw new Error('not connected');
                }

                // update our most-recently-seem timestamp -- we're not stale!
                roomState.peers[peerId].lastSeenTs = Date.now();

                callback({
                    peers: roomState.peers,
                    activeSpeaker: roomState.activeSpeaker
                });
            } catch (e) {
                console.error(e.message);
                callback({ error: e.message });
            }
        });

        socket.on('resumeConsumer', async (data, callback) => {
            try {
                let { consumerId } = data,
                    consumer = roomState.consumers.find((c) => c.id === consumerId);

                if (!consumer) {
                    console.log(`pause-consumer: server-side consumer ${consumerId} not found`);
                    callback({ error: `server-side consumer ${consumerId} not found` });
                    return;
                }

                console.log('resume-consumer', consumer.appData);

                await consumer.resume();

                callback({ resumed: true });
            } catch (e) {
                console.error('error in /signaling/resume-consumer', e);
                callback({ error: e });
            }
        });

        socket.on('pauseConsumer', async (data, callback) => {
            try {
                let { consumerId } = data,
                    consumer = roomState.consumers.find((c) => c.id === consumerId);

                if (!consumer) {
                    console.log(`pause-consumer: server-side consumer ${consumerId} not found`);
                    callback({ error: `server-side producer ${consumerId} not found` });
                    return;
                }

                console.log('pause-consumer', consumer.appData);

                await consumer.pause();

                callback({ paused: true });
            } catch (e) {
                console.error('error in /signaling/pause-consumer', e);
                callback({ error: e });
            }
        });

    })
}

function closePeer(peerId) {
    console.log('closing peer', peerId);
    for (let [id, transport] of Object.entries(roomState.transports)) {
        if (transport.appData.peerId === peerId) {
            closeTransport(transport);
        }
    }
    delete roomState.peers[peerId];
}

async function closeTransport(transport) {
    try {
        console.log('closing transport', transport.id, transport.appData);

        // our producer and consumer event handlers will take care of
        // calling closeProducer() and closeConsumer() on all the producers
        // and consumers associated with this transport
        await transport.close();

        // so all we need to do, after we call transport.close(), is update
        // our roomState data structure
        delete roomState.transports[transport.id];
    } catch (e) {
        console.log(e);
    }
}

async function closeConsumer(consumer) {
    console.log('closing consumer', consumer.id, consumer.appData);
    await consumer.close();

    // remove this consumer from our roomState.consumers list
    roomState.consumers = roomState.consumers.filter((c) => c.id !== consumer.id);

    // remove layer info from from our roomState...consumerLayers bookkeeping
    if (roomState.peers[consumer.appData.peerId]) {
        delete roomState.peers[consumer.appData.peerId].consumerLayers[consumer.id];
    }
}

async function closeProducer(producer) {
    console.log('closing producer', producer.id, producer.appData);
    try {
        await producer.close();

        // remove this producer from our roomState.producers list
        roomState.producers = roomState.producers
            .filter((p) => p.id !== producer.id);

        // remove this track's info from our roomState...mediaTag bookkeeping
        if (roomState.peers[producer.appData.peerId]) {
            delete (roomState.peers[producer.appData.peerId]
                .media[producer.appData.mediaTag]);
        }
    } catch (e) {
        console.log(e);
    }
}

async function createWebRtcTransport({ peerId, direction }) {
    const {
        listenIps,
        initialAvailableOutgoingBitrate
    } = config.mediasoup.webRtcTransport;

    const transport = await router.createWebRtcTransport({
        listenIps: listenIps,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate,
        appData: { peerId, clientDirection: direction }
    });
    return transport;
}

function periodicCleanUp() {

}

async function updatePeerStats() {
    for (let producer of roomState.producers) {
        if (producer.kind !== 'video') {
            continue;
        }
        try {
            let stats = await producer.getStats(),
                peerId = producer.appData.peerId;
            roomState.peers[peerId].stats[producer.id] = stats.map((s) => ({
                bitrate: s.bitrate,
                fractionLost: s.fractionLost,
                jitter: s.jitter,
                score: s.score,
                rid: s.rid
            }));
        } catch (e) {
            console.log('error while updating producer stats', e);
        }
    }

    for (let consumer of roomState.consumers) {
        try {
            let stats = (await consumer.getStats())
                .find((s) => s.type === 'outbound-rtp'),
                peerId = consumer.appData.peerId;
            if (!stats || !roomState.peers[peerId]) {
                continue;
            }
            roomState.peers[peerId].stats[consumer.id] = {
                bitrate: stats.bitrate,
                fractionLost: stats.fractionLost,
                score: stats.score
            }
        } catch (e) {
            console.log('error while updating consumer stats', e);
        }
    }
}

async function startExpress() {
    try {
        const tls = {
            cert: fs.readFileSync(config.sslCrt),
            key: fs.readFileSync(config.sslKey),
        };
        httpsServer = https.createServer(tls, expressApp);
        httpsServer.on('error', (e) => {
            console.error('https server error,', e.message);
        });
        await new Promise((resolve) => {
            httpsServer.listen(config.httpPort, config.httpIp, () => {
                console.log(`server is running and listening on ` +
                    `https://${config.httpIp}:${config.httpPort}`);
                resolve();
            });
        });
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.error('no certificates found (check config.js)');
            console.error('  could not start https server ... trying http');
        } else {
            err('could not start https server', e);
        }
        expressApp.listen(config.httpPort, config.httpIp, () => {
            console.log(`http server listening on port ${config.httpPort}`);
        });
    }

    // server.listen(config.httpPort, () => {
    //     console.log(`http server listening on port ${config.httpPort}`);
    // });
    // }
}

async function startMediaSoup() {
    let worker = await mediasoup.createWorker({
        logLevel: config.mediasoup.worker.logLevel,
        logTags: config.mediasoup.worker.logTags,
        rtcMinPort: config.mediasoup.worker.rtcMinPort,
        rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
    });

    worker.on('died', () => {
        console.error('mediasoup worker died (this should never happen)');
        process.exit(1);
    });

    const mediaCodecs = config.mediasoup.router.mediaCodecs;
    const router = await worker.createRouter({ mediaCodecs });

    const audioLevelObserver = await router.createAudioLevelObserver({
        interval: 800
    });
    audioLevelObserver.on('volumes', (volumes) => {
        const { producer, volume } = volumes[0];
        log('audio-level volumes event', producer.appData.peerId, volume);
        roomState.activeSpeaker.producerId = producer.id;
        roomState.activeSpeaker.volume = volumes;
        roomState.activeSpeaker.peerId = producer.appData.peerId;
    });
    audioLevelObserver.on('silence', () => {
        log('audio-level silence event');
        roomState.activeSpeaker.producerId = null;
        roomState.activeSpeaker.volume = null;
        roomState.activeSpeaker.peerId = null;
    });
    return { worker, router, audioLevelObserver };
}