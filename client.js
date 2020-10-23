const mediasoup = require('mediasoup-client');
const socketClient = require('socket.io-client');
// const { httpIp } = require('./config');
const socketPromise = require('./lib/socket.io-promise').promise;
const config = require('./config');
const deepEqual = require('deep-equal');
// import deepEqual from 'deep-equal';
// import debugModule from 'debug';

const $ = document.querySelector.bind(document);
const $$ = document.querySelectorAll.bind(document);
const fromId = document.getElementById.bind(document);

// const log = debugModule('demo-app');
// const warn = debugModule('demo-app:WARN');
// const err = debugModule('demo-app:ERROR');

const joinRoomBtn = fromId('join-button');
const sendCameraStreamsBtn = fromId('send-camera');
const localCamCheckbox = fromId('local-cam-checkbox');
const localMicCheckbox = fromId('local-mic-checkbox');
const localScreenCheckbox = fromId('local-screen-checkbox');
const localScreenAudioCheckbox = fromId('local-screen-audio-checkbox');
const cameraInfo = fromId('camera-info');
const stopStreamsBtn = fromId('stop-streams');
const shareScreenBtn = fromId('share-screen');
let switchCameraBtn;

joinRoomBtn.addEventListener('click', joinRoom);
sendCameraStreamsBtn.addEventListener('click', sendCameraStreams);
stopStreamsBtn.addEventListener('click', stopStreams);
shareScreenBtn.addEventListener('click', startScreenshare);
localCamCheckbox.addEventListener('change', changeCamPaused);
localMicCheckbox.addEventListener('change', changeMicPaused);
localScreenCheckbox.addEventListener('change', changeScreenPaused);
localScreenAudioCheckbox.addEventListener('change', changeScreenAudioPaused);
// localCamCheckbox.addEventListener('change', )
window.onload = main;

const hostname = window.location.hostname;

const myPeerId = uuidv4();
let device,
    joined,
    localCam,
    localScreen,
    recvTransport,
    sendTransport,
    camVideoProducer,
    camAudioProducer,
    screenVideoProducer,
    screenAudioProducer,
    currentActiveSpeaker = {},
    lastPollSyncData = {},
    consumers = [],
    socket,
    pollingInterval;

async function main() {
    console.log(`starting up ... my peerId is ${myPeerId}`);
    try {
        device = new mediasoup.Device();
        console.log(`device ` + device);
    } catch (e) {
        if (e.name === 'UnsupportedError') {
            console.error('browser not supported for video calls');
            return;
        } else {
            console.error(e);
        }
    }

    // use sendBeacon to tell the server we're disconnecting when
    // the page unloads
    // window.addEventListener('unload', () => sig('leave', {}, true));
}


async function joinRoom() {
    if (joined) {
        return;
    }

    console.log('join room');
    $('#join-control').style.display = 'none';

    try {
        const opts = {
            path: '/server',
            transports: ['websocket']
        };

        const serverUrl = `https://${hostname}:${config.httpPort}`;
        // const serverUrl = `https://${hostname}`;
        console.log(`url ` + serverUrl);
        socket = socketClient(serverUrl, opts);
        socket.request = socketPromise(socket);

        socket.on('connect', async () => {
            console.log(`connect in client`);

            let routerRtpCapabilities = await socket.request('joinAsNewPeer', { myPeerId });
            console.log(`socket working`, routerRtpCapabilities);
            if (!device.loaded) {
                await device.load({ routerRtpCapabilities });
            }
            joined = true;
            $('#leave-room').style.display = 'initial';
        });

        socket.on('disconnect', () => {
            console.log(`disconnect in client`)
        });

        socket.on('connect_error', (error) => {
            console.error('could not connect to %s%s (%s)', serverUrl, opts.path, error.message);
        });

        // signal that we're a new peer and initialize our
        // mediasoup-client device, if this is our first time connecting
    } catch (e) {
        console.error(e);
        return;
    }

    // super-simple signaling: let's poll at 1-second intervals
    pollingInterval = setInterval(async () => {
        let { error } = await pollAndUpdate();
        if (error) {
            clearInterval(pollingInterval);
            err(error);
        }
    }, 1000);
}

async function pollAndUpdate() {
    let { peers, activeSpeaker, error } = await socket.request('sync', { myPeerId });
    if (error) {
        return ({ error });
    }

    currentActiveSpeaker = activeSpeaker;
    updateActiveSpeaker();
    updateCamVideoProducerStatsDisplay();
    updateScreenVideoProducerStatsDisplay();
    updateConsumersStatsDisplay();

    let thisPeersList = sortPeers(peers),
        lastPeersList = sortPeers(lastPollSyncData);
    if (!deepEqual(thisPeersList, lastPeersList)) {
        updatePeersDisplay(peers, thisPeersList);
    }

    for (let id in lastPollSyncData) {
        if (!peers[id]) {
            console.log(`peer ${id} has exited`);
            consumers.forEach((consumer) => {
                if (consumer.appData.peerId === id) {
                    closeConsumer(consumer);
                }
            });
        }
    }

    consumers.forEach((consumer) => {
        let { peerId, mediaTag } = consumer.appData;
        if (!peers[peerId].media[mediaTag]) {
            console.log(`peer ${peerId} has stopped transmitting ${mediaTag}`);
            closeConsumer(consumer);
        }
    });

    lastPollSyncData = peers;
    return ({});
}

async function closeConsumer(consumer) {
    if (!consumer) {
        return;
    }
    console.log('closing consumer', consumer.appData.peerId, consumer.appData.mediaTag);
    try {
        // tell the server we're closing this consumer. (the server-side
        // consumer may have been closed already, but that's okay.)
        await socket.request('closeConsumer', { consumerId: consumer.id });
        await consumer.close();

        consumers = consumers.filter((c) => c !== consumer);
        removeVideoAudio(consumer);
    } catch (e) {
        console.error(e);
    }
}

async function updatePeersDisplay(peersInfo = lastPollSyncData,
    sortedPeers = sortPeers(peersInfo)) {
    console.log('room state updated', peersInfo);

    $('#available-tracks').innerHTML = '';
    if (camVideoProducer) {
        $('#available-tracks')
            .appendChild(makeTrackControlEl('my', 'cam-video',
                peersInfo[myPeerId].media['cam-video']));
    }
    if (camAudioProducer) {
        $('#available-tracks')
            .appendChild(makeTrackControlEl('my', 'cam-audio',
                peersInfo[myPeerId].media['cam-audio']));
    }
    if (screenVideoProducer) {
        $('#available-tracks')
            .appendChild(makeTrackControlEl('my', 'screen-video',
                peersInfo[myPeerId].media['screen-video']));
    }
    if (screenAudioProducer) {
        $('#available-tracks')
            .appendChild(makeTrackControlEl('my', 'screen-audio',
                peersInfo[myPeerId].media['screen-audio']));
    }

    for (let peer of sortedPeers) {
        if (peer.id === myPeerId) {
            continue;
        }
        for (let [mediaTag, info] of Object.entries(peer.media)) {
            $('#available-tracks')
                .appendChild(makeTrackControlEl(peer.id, mediaTag, info));
        }
    }
}

function makeTrackControlEl(peerName, mediaTag, mediaInfo) {
    let div = document.createElement('div');
    let peerId = (peerName === 'my' ? myPeerId : peerName);
    let consumer = findConsumerForTrack(peerId, mediaTag);
    div.classList = `track-subscribe track-subscribe-${peerId}`;

    let sub = document.createElement('button');
    if (!consumer) {
        sub.innerHTML += 'subscribe';
        sub.onclick = () => subscribeToTrack(peerId, mediaTag);
        div.appendChild(sub);
    } else {
        sub.innerHTML += 'unsubscribe'
        sub.onclick = () => unsubscribeFromTrack(peerId, mediaTag);
        div.appendChild(sub);
    }

    let trackDescription = document.createElement('span');
    trackDescription.innerHTML = `${peerName} ${mediaTag}`
    div.appendChild(trackDescription);

    try {
        if (mediaInfo) {
            let producerPaused = mediaInfo.paused;
            let prodPauseInfo = document.createElement('span');
            prodPauseInfo.innerHTML = producerPaused ? '[producer paused]'
                : '[producer playing]';
            div.appendChild(prodPauseInfo);
        }
    } catch (e) {
        console.error(e);
    }

    if (consumer) {
        let pause = document.createElement('span'),
            checkbox = document.createElement('input'),
            label = document.createElement('label');
        pause.classList = 'nowrap';
        checkbox.type = 'checkbox';
        checkbox.checked = !consumer.paused;
        checkbox.onchange = async () => {
            if (checkbox.checked) {
                await resumeConsumer(consumer);
            } else {
                await pauseConsumer(consumer);
            }
            updatePeersDisplay();
        }
        label.id = `consumer-stats-${consumer.id}`;
        if (consumer.paused) {
            label.innerHTML = '[consumer paused]'
        } else {
            let stats = lastPollSyncData[myPeerId].stats[consumer.id],
                bitrate = '-';
            if (stats) {
                bitrate = Math.floor(stats.bitrate / 1000.0);
            }
            label.innerHTML = `[consumer playing ${bitrate} kb/s]`;
        }
        pause.appendChild(checkbox);
        pause.appendChild(label);
        div.appendChild(pause);

        if (consumer.kind === 'video') {
            let remoteProducerInfo = document.createElement('span');
            remoteProducerInfo.classList = 'nowrap track-ctrl';
            remoteProducerInfo.id = `track-ctrl-${consumer.producerId}`;
            div.appendChild(remoteProducerInfo);
        }
    }

    return div;
}

async function pauseConsumer(consumer) {
    if (consumer) {
        console.log('pause consumer', consumer.appData.peerId, consumer.appData.mediaTag);
        try {
            await socket.request('pauseConsumer', { consumerId: consumer.id });
            await consumer.pause();
        } catch (e) {
            console.error(e);
        }
    }
}

async function resumeConsumer(consumer) {
    if (consumer) {
        console.log('resume consumer', consumer.appData.peerId, consumer.appData.mediaTag);
        try {
            await socket.request('resumeConsumer', { consumerId: consumer.id });
            await consumer.resume();
        } catch (e) {
            console.error(e);
        }
    }
}


function sortPeers(peers) {
    return Object.entries(peers)
        .map(([id, info]) => ({ id, joinTs: info.joinTs, media: { ...info.media } }))
        .sort((a, b) => (a.joinTs > b.joinTs) ? 1 : ((b.joinTs > a.joinTs) ? -1 : 0));
}

function findConsumerForTrack(peerId, mediaTag) {
    return consumers.find((c) => (c.appData.peerId === peerId &&
        c.appData.mediaTag === mediaTag));
}

async function subscribeToTrack(peerId, mediaTag) {
    console.log('subscribe to track', peerId, mediaTag);

    // create a receive transport if we don't already have one
    if (!recvTransport) {
        recvTransport = await createTransport('recv');
    }

    // if we do already have a consumer, we shouldn't have called this
    // method
    let consumer = findConsumerForTrack(peerId, mediaTag);
    if (consumer) {
        console.log('already have consumer for track', peerId, mediaTag)
        return;
    };

    // ask the server to create a server-side consumer object and send
    // us back the info we need to create a client-side consumer
    let consumerParameters = await socket.request('recvTrack', {
        peerId: myPeerId,
        mediaTag,
        mediaPeerId: peerId,
        rtpCapabilities: device.rtpCapabilities
    });
    console.log('consumer parameters', consumerParameters);
    consumer = await recvTransport.consume({
        ...consumerParameters,
        appData: { peerId, mediaTag }
    });
    console.log('created new consumer', consumer.id);

    // the server-side consumer will be started in paused state. wait
    // until we're connected, then send a resume request to the server
    // to get our first keyframe and start displaying video
    while (recvTransport.connectionState !== 'connected') {
        console.log('  transport connstate', recvTransport.connectionState);
        await sleep(100);
    }
    // okay, we're ready. let's ask the peer to send us media
    await resumeConsumer(consumer);

    // keep track of all our consumers
    consumers.push(consumer);

    // ui
    await addVideoAudio(consumer);
    updatePeersDisplay();
}

function addVideoAudio(consumer) {
    if (!(consumer && consumer.track)) {
        return;
    }
    let el = document.createElement(consumer.kind);
    // set some attributes on our audio and video elements to make
    // mobile Safari happy. note that for audio to play you need to be
    // capturing from the mic/camera
    if (consumer.kind === 'video') {
        el.setAttribute('playsinline', true);
    } else {
        el.setAttribute('playsinline', true);
        el.setAttribute('autoplay', true);
    }
    $(`#remote-${consumer.kind}`).appendChild(el);
    el.srcObject = new MediaStream([consumer.track.clone()]);
    el.consumer = consumer;
    // let's "yield" and return before playing, rather than awaiting on
    // play() succeeding. play() will not succeed on a producer-paused
    // track until the producer unpauses.
    el.play()
        .then(() => { })
        .catch((e) => {
            err(e);
        });
}

function updateActiveSpeaker() {
    $$('.track-subscribe').forEach((el) => {
        el.classList.remove('active-speaker');
    });
    if (currentActiveSpeaker.peerId) {
        $$(`.track-subscribe-${currentActiveSpeaker.peerId}`).forEach((el) => {
            el.classList.add('active-speaker');
        });
    }
}

function updateCamVideoProducerStatsDisplay() {
    let tracksEl = $('#camera-producer-stats');
    tracksEl.innerHTML = '';
    if (!camVideoProducer || camVideoProducer.paused) {
        return;
    }
    makeProducerTrackSelector({
        internalTag: 'local-cam-tracks',
        container: tracksEl,
        peerId: myPeerId,
        producerId: camVideoProducer.id,
        currentLayer: camVideoProducer.maxSpatialLayer,
        layerSwitchFunc: (i) => {
            console.log('client set layers for cam stream');
            camVideoProducer.setMaxSpatialLayer(i)
        }
    });
}
function updateScreenVideoProducerStatsDisplay() {
    let tracksEl = $('#screen-producer-stats');
    tracksEl.innerHTML = '';
    if (!screenVideoProducer || screenVideoProducer.paused) {
        return;
    }
    makeProducerTrackSelector({
        internalTag: 'local-screen-tracks',
        container: tracksEl,
        peerId: myPeerId,
        producerId: screenVideoProducer.id,
        currentLayer: screenVideoProducer.maxSpatialLayer,
        layerSwitchFunc: (i) => {
            console.log('client set layers for screen stream');
            screenVideoProducer.setMaxSpatialLayer(i)
        }
    });
}
function updateConsumersStatsDisplay() {
    try {
        for (let consumer of consumers) {
            let label = $(`#consumer-stats-${consumer.id}`);
            if (label) {
                if (consumer.paused) {
                    label.innerHTML = '(consumer paused)'
                } else {
                    let stats = lastPollSyncData[myPeerId].stats[consumer.id],
                        bitrate = '-';
                    if (stats) {
                        bitrate = Math.floor(stats.bitrate / 1000.0);
                    }
                    label.innerHTML = `[consumer playing ${bitrate} kb/s]`;
                }
            }

            let mediaInfo = lastPollSyncData[consumer.appData.peerId] &&
                lastPollSyncData[consumer.appData.peerId]
                    .media[consumer.appData.mediaTag];
            if (mediaInfo && !mediaInfo.paused) {
                let tracksEl = $(`#track-ctrl-${consumer.producerId}`);
                if (tracksEl && lastPollSyncData[myPeerId]
                    .consumerLayers[consumer.id]) {
                    tracksEl.innerHTML = '';
                    let currentLayer = lastPollSyncData[myPeerId]
                        .consumerLayers[consumer.id].currentLayer;
                    makeProducerTrackSelector({
                        internalTag: consumer.id,
                        container: tracksEl,
                        peerId: consumer.appData.peerId,
                        producerId: consumer.producerId,
                        currentLayer: currentLayer,
                        layerSwitchFunc: (i) => {
                            console.log('ask server to set layers');
                            socket.request('consumerSetLayers', {
                                consumerId: consumer.id,
                                spatialLayer: i
                            });
                        }
                    });
                }
            }
        }
    } catch (e) {
        console.log('error while updating consumers stats display', e);
    }
}


async function sendCameraStreams() {
    console.log(`send camera streams`);
    $('#send-camera').style.display = 'none';

    // make sure we've joined the room and started our camera. these
    // functions don't do anything if they've already been called this
    // session
    await joinRoom();
    await startCamera();

    // create a transport for outgoing media, if we don't already have one
    if (!sendTransport) {
        sendTransport = await createTransport('send');
    }

    camVideoProducer = await sendTransport.produce({
        track: localCam.getVideoTracks()[0],
        encodings: camEncodings(),
        appData: { mediaTag: 'cam-video' }
    });
    if (getCamPausedState()) {
        try {
            await camVideoProducer.pause();
        } catch (e) {
            console.error(e);
        }
    }

    camAudioProducer = await sendTransport.produce({
        track: localCam.getAudioTracks()[0],
        appData: { mediaTag: 'cam-audio' }
    });
    if (getMicPausedState()) {
        try {
            camAudioProducer.pause();
        } catch (e) {
            console.error(e);
        }
    }

    console.log(`camVideoProducer`, camVideoProducer);
    console.log(`camAudioProducer`, camAudioProducer);

    $('#stop-streams').style.display = 'initial';
    showCameraInfo();
}

async function showCameraInfo() {
    console.log(`show camera info`);
    let deviceId = await getCurrentDeviceId();
    let infoEl = cameraInfo;
    if (!deviceId) {
        infoEl.innerHTML = '';
        return;
    }
    let devices = await navigator.mediaDevices.enumerateDevices();
    let deviceInfo = devices.find((device) => device.deviceId === deviceId);
    infoEl.innerHTML = `${deviceInfo.label}
    <button id="switch-camera">switch camera</button>`;
    switchCameraBtn = fromId('switch-camera');
    switchCameraBtn.addEventListener('click', cycleCamera);
}

async function getCurrentDeviceId() {
    if (!camVideoProducer) {
        return null;
    }
    let deviceId = camVideoProducer.track.getSettings().deviceId;
    if (deviceId) {
        return deviceId;
    }
    let track = localCam && localCam.getVideoTracks()[0];
    if (!track) {
        return null;
    }
    let devices = await navigator.mediaDevices.enumerateDevices();
    let deviceInfo = devices.find((device) => device.label.startsWith(track.label));
    return deviceInfo.deviceId;
}

async function startCamera() {
    if (localCam) {
        return;
    }
    console.log(`start camera`);
    try {
        localCam = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
    } catch (error) {
        console.log(`start camera error`, error);
    }
}

async function createTransport(direction) {
    console.log(`create ${direction} transport`);

    let transport,
        { transportOptions } = await socket.request('createTransport', { myPeerId, direction });
    console.log(`transport option`, transportOptions);

    if (direction === 'recv') {
        transport = await device.createRecvTransport(transportOptions);
    } else if (direction === 'send') {
        transport = await device.createSendTransport(transportOptions);
    } else {
        throw new Error(`bad transport 'direction': ${direction}`);
    }

    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        console.log(`transport connect event`, direction);
        console.log(`===============================================================================================================================`,myPeerId);
        socket.request('connectTransport', {
            myPeerId,
            transportId: transportOptions.id,
            dtlsParameters,
        })
            .then(callback)
            .catch(errback);
    });

    if (direction === 'send') {
        transport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
            console.log(`transport produce event`, appData.mediaTag);
            let paused = false;
            if (appData.mediaTag === 'cam-video') {
                paused = getCamPausedState();
            } else if (appData.mediaTag === 'cam-audio') {
                paused = getMicPausedState();
            }

            console.log('inside transport.on(produce)', appData, paused);

            try {
                const { id } = await socket.request('sendTrack', {
                    myPeerId,
                    transportId: transportOptions.id,
                    kind,
                    rtpParameters,
                    paused,
                    appData
                });
                callback({ id });
            } catch (err) {
                errback(err);
            }
        });
    }

    transport.on('connectionstatechange', async (state) => {
        console.log(`transport ${transport.id} connectionstatechange ${state}`);
        if (state === 'closed' || state === 'failed' || state === 'disconnected') {
            console.log(`transport closed... leaving the room and resetting`);
            leaveRoom();
        }
    });
    return transport;
}


async function cycleCamera() {
    if (!(camVideoProducer && camVideoProducer.track)) {
        console.log('cannot cycle camera - no current camera track');
        return;
    }
    console.log(`cycle camera`);
    let deviceId = await getCurrentDeviceId();
    let allDevices = await navigator.mediaDevices.enumerateDevices();
    let vidDevices = allDevices.filter((device) => device.kind === 'videoinput');
    if (vidDevices.length < 2) {
        console.log('cannot cycle camera - only one camera');
        return;
    }
    let idx = vidDevices.findIndex((device) => device.deviceId === deviceId);
    idx += 1;
    idx = idx % (vidDevices.length);

    log('getting a video stream from new device', vidDevices[idx].label);
    localCam = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: vidDevices[idx].deviceId } },
        audio: true
    });

    // replace the tracks we are sending
    await camVideoProducer.replaceTrack({ track: localCam.getVideoTracks()[0] });
    await camAudioProducer.replaceTrack({ track: localCam.getAudioTracks()[0] });

    // update the user interface
    showCameraInfo();
}


async function leaveRoom() {
    console.log(`leaveRoom`);
}

function uuidv4() {
    return ('111-111-1111').replace(/[018]/g, () =>
        (crypto.getRandomValues(new Uint8Array(1))[0] & 15).toString(16));
}

//
// encodings for outgoing video
//

// just two resolutions, for now, as chrome 75 seems to ignore more
// than two encodings
//
const CAM_VIDEO_SIMULCAST_ENCODINGS =
    [
        { maxBitrate: 96000, scaleResolutionDownBy: 4 },
        { maxBitrate: 680000, scaleResolutionDownBy: 1 },
    ];

function camEncodings() {
    return CAM_VIDEO_SIMULCAST_ENCODINGS;
}


function getCamPausedState() {
    return !localCamCheckbox.checked;
}

function getMicPausedState() {
    return !localMicCheckbox.checked;
}

async function stopStreams() {
    if (!(localCam || localScreen)) {
        return;
    }
    if (!sendTransport) {
        return;
    }

    console.log('stop sending media streams');
    $('#stop-streams').style.display = 'none';

    let { error } = await socket.request('closeTransport', {
        myPeerId,
        transportId: sendTransport.id
    });
    if (error) {
        err(error);
    }
    // closing the sendTransport closes all associated producers. when
    // the camVideoProducer and camAudioProducer are closed,
    // mediasoup-client stops the local cam tracks, so we don't need to
    // do anything except set all our local variables to null.
    try {
        await sendTransport.close();
    } catch (e) {
        console.error(e);
    }
    sendTransport = null;
    camVideoProducer = null;
    camAudioProducer = null;
    screenVideoProducer = null;
    screenAudioProducer = null;
    localCam = null;
    localScreen = null;

    // update relevant ui elements
    $('#send-camera').style.display = 'initial';
    $('#share-screen').style.display = 'initial';
    $('#local-screen-pause-ctrl').style.display = 'none';
    $('#local-screen-audio-pause-ctrl').style.display = 'none';
    showCameraInfo();
}


async function startScreenshare() {
    console.log('start screen share');
    $('#share-screen').style.display = 'none';

    // make sure we've joined the room and that we have a sending
    // transport
    await joinRoom();
    if (!sendTransport) {
        sendTransport = await createTransport('send');
    }

    // get a screen share track
    localScreen = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
    });

    // create a producer for video
    screenVideoProducer = await sendTransport.produce({
        track: localScreen.getVideoTracks()[0],
        encodings: screenshareEncodings(),
        appData: { mediaTag: 'screen-video' }
    });

    // create a producer for audio, if we have it
    if (localScreen.getAudioTracks().length) {
        screenAudioProducer = await sendTransport.produce({
            track: localScreen.getAudioTracks()[0],
            appData: { mediaTag: 'screen-audio' }
        });
    }

    // handler for screen share stopped event (triggered by the
    // browser's built-in screen sharing ui)
    screenVideoProducer.track.onended = async () => {
        console.log('screen share stopped');
        try {
            await screenVideoProducer.pause();
            let { error } = await socket.request('closeProducer', {
                myPeerId,
                producerId: screenVideoProducer.id
            });
            await screenVideoProducer.close();
            screenVideoProducer = null;
            if (error) {
                err(error);
            }
            if (screenAudioProducer) {
                let { error } = socket.request('closeProducer', {
                    myPeerId,
                    producerId: screenAudioProducer.id
                });
                await screenAudioProducer.close();
                screenAudioProducer = null;
                if (error) {
                    err(error);
                }
            }
        } catch (e) {
            console.error(e);
        }
        $('#local-screen-pause-ctrl').style.display = 'none';
        $('#local-screen-audio-pause-ctrl').style.display = 'none';
        $('#share-screen').style.display = 'initial';
    }

    $('#local-screen-pause-ctrl').style.display = 'block';
    if (screenAudioProducer) {
        $('#local-screen-audio-pause-ctrl').style.display = 'block';
    }
}

async function changeCamPaused() {
    if (getCamPausedState()) {
        pauseProducer(camVideoProducer);
        $('#local-cam-label').innerHTML = 'camera (paused)';
    } else {
        resumeProducer(camVideoProducer);
        $('#local-cam-label').innerHTML = 'camera';
    }
}

async function changeMicPaused() {
    if (getMicPausedState()) {
        pauseProducer(camAudioProducer);
        $('#local-mic-label').innerHTML = 'mic (paused)';
    } else {
        resumeProducer(camAudioProducer);
        $('#local-mic-label').innerHTML = 'mic';
    }
}

async function changeScreenPaused() {
    if (getScreenPausedState()) {
        pauseProducer(screenVideoProducer);
        $('#local-screen-label').innerHTML = 'screen (paused)';
    } else {
        resumeProducer(screenVideoProducer);
        $('#local-screen-label').innerHTML = 'screen';
    }
}

async function changeScreenAudioPaused() {
    if (getScreenAudioPausedState()) {
        pauseProducer(screenAudioProducer);
        $('#local-screen-audio-label').innerHTML = 'screen (paused)';
    } else {
        resumeProducer(screenAudioProducer);
        $('#local-screen-audio-label').innerHTML = 'screen';
    }
}


async function pauseProducer(producer) {
    if (producer) {
        console.log('pause producer', producer.appData.mediaTag);
        try {
            await socket.request('pauseProducer', { myPeerId, producerId: producer.id });
            await producer.pause();
        } catch (e) {
            console.error(e);
        }
    }
}

async function resumeProducer(producer) {
    if (producer) {
        console.log('resume producer', producer.appData.mediaTag);
        try {
            await socket.request('resumeProducer', { myPeerId, producerId: producer.id });
            await producer.resume();
        } catch (e) {
            console.error(e);
        }
    }
}


function makeProducerTrackSelector({ internalTag, container, peerId, producerId,
    currentLayer, layerSwitchFunc }) {
    try {
        let pollStats = lastPollSyncData[peerId] &&
            lastPollSyncData[peerId].stats[producerId];
        if (!pollStats) {
            return;
        }

        let stats = [...Array.from(pollStats)]
            .sort((a, b) => a.rid > b.rid ? 1 : (a.rid < b.rid ? -1 : 0));
        let i = 0;
        for (let s of stats) {
            let div = document.createElement('div'),
                radio = document.createElement('input'),
                label = document.createElement('label'),
                x = i;
            radio.type = 'radio';
            radio.name = `radio-${internalTag}-${producerId}`;
            radio.checked = currentLayer == undefined ?
                (i === stats.length - 1) :
                (i === currentLayer);
            radio.onchange = () => layerSwitchFunc(x);
            let bitrate = Math.floor(s.bitrate / 1000);
            label.innerHTML = `${bitrate} kb/s`;
            div.appendChild(radio);
            div.appendChild(label);
            container.appendChild(div);
            i++;
        }
        if (i) {
            let txt = document.createElement('div');
            txt.innerHTML = 'tracks';
            container.insertBefore(txt, container.firstChild);
        }
    } catch (e) {
        console.log('error while updating track stats display', e);
    }
}


async function unsubscribeFromTrack(peerId, mediaTag) {
    let consumer = findConsumerForTrack(peerId, mediaTag);
    if (!consumer) {
        return;
    }

    log('unsubscribe from track', peerId, mediaTag);
    try {
        await closeConsumer(consumer);
    } catch (e) {
        console.error(e);
    }
    // force update of ui
    updatePeersDisplay();
}


async function sleep(ms) {
    return new Promise((r) => setTimeout(() => r(), ms));
  }
  