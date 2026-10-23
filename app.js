/* Coffeebreak SIM 3. App-to-app voice and video calling. Written fresh for Karen O'Brien (Coffeebreak). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var TOPIC = 'cbsim3-';
  var clean = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24); };
  var rand = function (n) { var s = ''; var a = 'abcdefghijklmnopqrstuvwxyz0123456789'; for (var i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var params = new URLSearchParams(location.search);
  var LS = (function () { try { localStorage.setItem('cbsim3.t', '1'); localStorage.removeItem('cbsim3.t'); return localStorage; } catch (e) { var m = {}; return { getItem: function (k) { return m[k] || null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } }; } })();

  var me = clean(params.get('me')) || clean(LS.getItem('cbsim3.me'));
  if (clean(params.get('me'))) LS.setItem('cbsim3.me', me);

  /* ---------- small helpers ---------- */
  function withTimeout(p, ms, fallback) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(fallback); } }, ms);
      p.then(function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } }, function () { if (!done) { done = true; clearTimeout(t); resolve(fallback); } });
    });
  }

  /* ---------- connection list (STUN and TURN) ---------- */
  var iceCache = null;
  function getIce() {
    if (iceCache) return Promise.resolve(iceCache);
    var url = 'https://songwriterkaz.github.io/coffeebreak-ice/ice.json?t=' + Math.floor(Date.now() / 600000);
    var fromNet = fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.iceServers && j.iceServers.length) { LS.setItem('cbsim3.ice', JSON.stringify(j.iceServers)); return j.iceServers; }
      return null;
    });
    return withTimeout(fromNet, 4000, null).then(function (list) {
      if (!list) { try { list = JSON.parse(LS.getItem('cbsim3.ice') || 'null'); } catch (e) { list = null; } }
      if (!list) list = (window.CB_ICE_FALLBACK || {}).iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
      iceCache = list;
      return list;
    });
  }
  function hasTurn(list) { return list.some(function (s) { return s.username; }); }

  /* ---------- signalling: two routes used together ---------- */
  var seen = {};
  var routes = { a: { up: false, label: 'Line 1' }, b: { up: false, label: 'Line 2' } };
  var sigGen = 0;
  var ws = null, wsTimer = null, wsHb = null, wsFails = 0;
  var ntfyAbort = null, ntfyLast = null, ntfyFails = 0, ntfyFirst = true;
  var selfTests = {};

  function onSignal(env, via) {
    if (!env || typeof env !== 'object' || !env.id) return;
    if (seen[env.id]) return;
    seen[env.id] = 1;
    if (clean(env.to) !== me) return;
    if (env.t === 'part') { onPart(env, via); return; }
    if (env.t === 'selftest') { if (selfTests[env.id0]) selfTests[env.id0](via); return; }
    try { handleSignal(env, via); } catch (e) { log('signal error ' + e.message); }
  }

  /* Line 1: PeerJS cloud server over a web socket */
  function wsStart() {
    var gen = sigGen;
    if (!me) return;
    clearTimeout(wsTimer);
    var sock;
    try { sock = new WebSocket('wss://0.peerjs.com/peerjs?key=peerjs&id=' + TOPIC + me + '&token=' + rand(12)); } catch (e) { return wsRetry(gen); }
    ws = sock;
    var opened = false;
    var watchdog = setTimeout(function () { if (!opened) { try { sock.close(); } catch (e) {} } }, 9000);
    sock.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type !== 'OPEN' && m.type !== 'OFFER' && m.type !== 'ANSWER' && m.type !== 'CANDIDATE') log('ws msg ' + ev.data.slice(0, 120));
      if (m.type === 'OPEN') { opened = true; wsFails = 0; routes.a.up = true; routes.a.note = ''; clearTimeout(watchdog); render(); }
      else if (m.type === 'ID-TAKEN') { routes.a.note = 'name in use on another device'; }
      else if (m.type === 'OFFER' || m.type === 'ANSWER' || m.type === 'CANDIDATE' || m.type === 'LEAVE') { onSignal(m.payload && m.payload.cb ? m.payload.cb : m.payload, 'a'); }
    };
    sock.onclose = function (ev) {
      log('ws close ' + (ev && ev.code) + ' opened=' + opened);
      clearTimeout(watchdog);
      if (ws === sock) { routes.a.up = false; render(); }
      if (gen === sigGen) wsRetry(gen);
    };
    sock.onerror = function () { try { sock.close(); } catch (e) {} };
    clearInterval(wsHb);
    wsHb = setInterval(function () { if (ws === sock && sock.readyState === 1) { try { sock.send(JSON.stringify({ type: 'HEARTBEAT' })); } catch (e) {} } }, 5000);
  }
  function wsRetry(gen) {
    if (gen !== sigGen) return;
    wsFails++;
    var d = Math.min(1000 * Math.pow(1.6, wsFails), wsFails > 4 ? 20000 : 8000);
    clearTimeout(wsTimer);
    wsTimer = setTimeout(function () { if (gen === sigGen) wsStart(); }, d);
  }
  function wsSend(to, env) {
    if (!ws || ws.readyState !== 1 || !routes.a.up) return false;
    // The relay only accepts well-formed candidate messages, so every message travels in that shape.
    try { ws.send(JSON.stringify({ type: 'CANDIDATE', dst: TOPIC + to, payload: { candidate: { candidate: 'cb' }, type: 'data', connectionId: 'cb', cb: env } })); return true; } catch (e) { return false; }
  }

  /* Line 2: ntfy.sh, listening on a stream and publishing with a plain post */
  async function ntfyStart() {
    var gen = sigGen;
    if (!me) return;
    while (gen === sigGen) {
      var ctrl = new AbortController();
      ntfyAbort = ctrl;
      var stall = null;
      try {
        var since = ntfyLast || (ntfyFirst ? '20s' : 'latest');
        var resp = await fetch('https://ntfy.sh/' + TOPIC + me + '/json?since=' + since, { signal: ctrl.signal, cache: 'no-store' });
        if (!resp.ok) throw new Error('http ' + resp.status);
        ntfyFirst = false;
        routes.b.up = true; routes.b.note = ''; ntfyFails = 0; render();
        var armStall = function () { clearTimeout(stall); stall = setTimeout(function () { ctrl.abort(); }, 75000); };
        armStall();
        if (resp.body && resp.body.getReader) {
          var reader = resp.body.getReader();
          var dec = new TextDecoder();
          var buf = '';
          while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;
            armStall();
            buf += dec.decode(chunk.value, { stream: true });
            var lines = buf.split('\n');
            buf = lines.pop();
            lines.forEach(ntfyLine);
          }
        } else {
          var text = await resp.text();
          text.split('\n').forEach(ntfyLine);
          await sleep(2500);
        }
      } catch (e) { /* retry below */ }
      clearTimeout(stall);
      if (gen !== sigGen) return;
      routes.b.up = false; render();
      ntfyFails++;
      await sleep(Math.min(1000 * Math.pow(1.6, ntfyFails), 20000));
    }
  }
  function ntfyLine(line) {
    if (!line || !line.trim()) return;
    var m; try { m = JSON.parse(line); } catch (e) { return; }
    if (m.id) ntfyLast = m.id;
    if (m.event === 'message' && m.message) { var env; try { env = JSON.parse(m.message); } catch (e) { return; } onSignal(env, 'b'); }
  }
  function ntfySend(to, env) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, 9000);
    return fetch('https://ntfy.sh/' + TOPIC + to, { method: 'POST', body: JSON.stringify(env), signal: ctrl.signal })
      .then(function (r) { clearTimeout(t); return r.ok; }, function () { clearTimeout(t); return false; });
  }

  function send(to, env) {
    env.id = env.id || rand(14);
    env.from = me; env.to = to; env.ts = Date.now();
    seen[env.id] = 1;
    var txt = JSON.stringify(env);
    if (txt.length <= 2600) { wsSend(to, env); ntfySend(to, env); return; }
    /* Video offers are long. Both routes cap message size, so long messages travel in small parts. */
    var n = Math.ceil(txt.length / 2200), mid = rand(10);
    for (var i = 0; i < n; i++) {
      var part = { t: 'part', id: rand(14), mid: mid, i: i, n: n, d: txt.slice(i * 2200, (i + 1) * 2200), from: me, to: to, ts: Date.now() };
      seen[part.id] = 1;
      wsSend(to, part); ntfySend(to, part);
    }
  }
  var partsIn = {};
  function onPart(env, via) {
    var p = partsIn[env.mid] = partsIn[env.mid] || { n: env.n, d: [], got: 0, done: false };
    if (p.done || p.d[env.i] != null) return;
    p.d[env.i] = env.d; p.got++;
    if (p.got < p.n) return;
    p.done = true;
    var inner; try { inner = JSON.parse(p.d.join('')); } catch (e) { return; }
    onSignal(inner, via);
  }
  function sigStart() {
    sigGen++;
    wsFails = 0; ntfyFails = 0; ntfyLast = null; ntfyFirst = true;
    routes.a.up = false; routes.b.up = false;
    try { if (ws) ws.close(); } catch (e) {}
    try { if (ntfyAbort) ntfyAbort.abort(); } catch (e) {}
    wsStart(); ntfyStart();
  }
  function nudge() {
    if (!me) return;
    if (!routes.a.up && (!ws || ws.readyState > 1)) { wsFails = 0; wsStart(); }
    if (!routes.b.up) { try { if (ntfyAbort) ntfyAbort.abort(); } catch (e) {} }
  }
  window.addEventListener('online', nudge);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') nudge(); });

  /* ---------- microphone ---------- */
  var mic = null;
  async function getMic() {
    if (mic && mic.getAudioTracks().some(function (t) { return t.readyState === 'live'; })) return mic;
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    return mic;
  }
  function stopMic() { if (mic) { mic.getTracks().forEach(function (t) { t.stop(); }); mic = null; } }
  function micErrorText(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'The microphone is blocked. Allow the microphone for this page in your browser settings, then tap Call again.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No microphone was found on this device.';
    if (n === 'NotReadableError') return 'The microphone is busy in another app. Close that app and try again.';
    return 'The microphone could not start.';
  }

  /* ---------- camera ---------- */
  var cam = null, camCount = 0;
  var isPhoneLike = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') && (navigator.maxTouchPoints || 0) > 0;
  function camConstraints(facing) { return { audio: false, video: { facingMode: { ideal: facing || 'user' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } }; }
  function camErrorText(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'The camera is blocked. Allow the camera for this page in your browser settings.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'TypeError') return 'No camera was found on this device.';
    if (n === 'NotReadableError') return 'The camera is busy in another app.';
    return 'The camera could not start.';
  }
  async function getCam(facing) {
    if (cam && cam.getVideoTracks().some(function (t) { return t.readyState === 'live'; })) return { stream: cam };
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw { name: 'NotFoundError' };
      cam = await navigator.mediaDevices.getUserMedia(camConstraints(facing));
      try { var devs = await navigator.mediaDevices.enumerateDevices(); camCount = devs.filter(function (d) { return d.kind === 'videoinput'; }).length; } catch (e) { camCount = 1; }
      return { stream: cam };
    } catch (e) { cam = null; return { error: e }; }
  }
  function stopCam() {
    if (cam) { cam.getTracks().forEach(function (t) { t.stop(); }); cam = null; }
    var lv = $('localVideo'), rv = $('remoteVideo'); lv.srcObject = null; rv.srcObject = null;
  }
  function showLocal(c) {
    var lv = $('localVideo');
    if (cam && lv.srcObject !== cam) { lv.srcObject = cam; var p = lv.play(); if (p && p.catch) p.catch(function () {}); }
    lv.classList.toggle('mirror', c.facing !== 'environment');
  }
  /* Gets the camera for a video call. If it fails, the call carries on as voice only. */
  async function prepareVideo(c) {
    if (!c.video) return;
    var r = await getCam(c.facing);
    if (!r.stream) { c.video = false; c.note = camErrorText(r.error) + ' This call is voice only.'; }
  }
  function capVideo(c) {
    try {
      c.pc.getSenders().forEach(function (sn) {
        if (!sn.track || sn.track.kind !== 'video') return;
        var p = sn.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = c.relay ? 450000 : 900000;
        sn.setParameters(p).catch(function () {});
      });
    } catch (e) {}
  }
  async function switchCamera() {
    var c = call; if (!c || !c.video || !cam || c.switching) return;
    c.switching = true;
    var prev = c.facing || 'user', next = prev === 'user' ? 'environment' : 'user';
    var old = cam.getVideoTracks();
    old.forEach(function (t) { t.stop(); });
    var s = null;
    try { s = await navigator.mediaDevices.getUserMedia(camConstraints(next)); c.facing = next; }
    catch (e) { try { s = await navigator.mediaDevices.getUserMedia(camConstraints(prev)); c.note = 'The other camera could not start.'; } catch (e2) { s = null; } }
    if (s) {
      var nt = s.getVideoTracks()[0]; nt.enabled = !c.camOff;
      var sender = c.pc && c.pc.getSenders().find(function (x) { return x.track && x.track.kind === 'video' || (x.track === null && x === c.vsender); });
      if (!sender && c.vsender) sender = c.vsender;
      if (sender) { try { await sender.replaceTrack(nt); } catch (e) { log('replace error ' + e.message); } }
      cam = s;
    } else { cam = null; c.video = false; c.note = 'The camera stopped. This call is voice only.'; }
    c.switching = false;
    $('localVideo').srcObject = null; if (cam) showLocal(c);
    render();
  }

  /* ---------- calls ---------- */
  var call = null;
  var ended = {};
  var ringTimer = null, tickTimer = null, statTimer = null, wake = null;
  var uiMsg = '';
  var ac = null, ringIv = null;

  function log(s) { try { (window.__cblog = window.__cblog || []).push(Date.now() + ' ' + s); } catch (e) {} }

  function newCall(peer, role, cid, relay) {
    return { cid: cid, peer: peer, role: role, relay: !!relay, state: role === 'caller' ? 'calling' : 'ringing', pc: null, outAll: [], outNew: [], inSeen: {}, inPending: [], rs: 0, accepted: role === 'caller', tries: 0, started: Date.now(), connectedAt: 0, muted: false, video: false, camOff: false, note: '', facing: 'user', remoteVideo: false, stats: {}, offer: null, answer: null, answeredRs: -1, timers: {} };
  }
  function setT(c, name, fn, ms) { clearTimeout(c.timers[name]); c.timers[name] = setTimeout(function () { if (call === c) fn(); }, ms); }
  function clearTimers(c) { Object.keys(c.timers).forEach(function (k) { clearTimeout(c.timers[k]); clearInterval(c.timers[k]); }); c.timers = {}; }

  async function makePc(c) {
    var list = await getIce();
    var cfg = { iceServers: list, iceCandidatePoolSize: 0 };
    if (c.relay) cfg.iceTransportPolicy = 'relay';
    if (c.sabotage) cfg = { iceServers: [], iceTransportPolicy: 'relay' };
    var pc = new RTCPeerConnection(cfg);
    c.pc = pc;
    pc.onicecandidate = function (e) {
      if (call !== c || c.pc !== pc || !e.candidate) return;
      var cand = { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex };
      c.outAll.push(cand); c.outNew.push(cand);
      setT(c, 'iceflush', function () { flushIce(c); }, 250);
    };
    pc.ontrack = function (e) {
      if (e.track.kind === 'video') {
        var rv = $('remoteVideo'); rv.srcObject = new MediaStream([e.track]);
        var pp = rv.play(); if (pp && pp.catch) pp.catch(function () {});
        c.remoteVideo = true; render(); return;
      }
      var a = $('remoteAudio');
      a.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      var p = a.play(); if (p && p.catch) p.catch(function () { uiMsg = 'Tap anywhere on the screen to hear the call.'; render(); });
    };
    var onState = function () { icestate(c, pc); };
    pc.oniceconnectionstatechange = onState;
    pc.onconnectionstatechange = onState;
    var stream = await getMic();
    stream.getAudioTracks().forEach(function (t) { t.enabled = !c.muted; pc.addTrack(t, stream); });
    if (c.video && cam) {
      cam.getVideoTracks().forEach(function (t) { t.enabled = !c.camOff; var sn = pc.addTrack(t, cam); c.vsender = sn; });
      showLocal(c);
    }
    return pc;
  }
  function flushIce(c) {
    if (!c.outNew.length || call !== c) return;
    var list = c.outNew; c.outNew = [];
    send(c.peer, { t: 'ice', cid: c.cid, rs: c.rs, c: list });
  }
  function addRemoteCands(c, list) {
    (list || []).forEach(function (cd) {
      if (!cd || !cd.candidate || c.inSeen[cd.candidate]) return;
      c.inSeen[cd.candidate] = 1;
      if (c.pc && c.pc.remoteDescription) { c.pc.addIceCandidate(cd).catch(function () {}); }
      else c.inPending.push(cd);
    });
  }
  function flushPending(c) { var l = c.inPending; c.inPending = []; l.forEach(function (cd) { c.pc.addIceCandidate(cd).catch(function () {}); }); }

  /* caller side */
  async function startCall(rawPeer, withVideo) {
    var peer = clean(rawPeer);
    if (!peer) { uiMsg = 'Type the SIM name you want to call.'; render(); return; }
    if (peer === me) { uiMsg = 'That is your own SIM name. Type a different name.'; render(); return; }
    if (call) return;
    unlockAudio();
    uiMsg = '';
    var c = newCall(peer, 'caller', rand(10), params.get('relay') === '1');
    c.sabotage = params.get('sabotage') === '1';
    c.video = !!withVideo;
    call = c; c.tries = 0;
    render();
    try { await getMic(); } catch (e) { call = null; uiMsg = micErrorText(e); render(); return; }
    if (call !== c) return;
    await prepareVideo(c);
    if (call !== c) return;
    render();
    try { await beginOffer(c, false); } catch (e) { log('offer error ' + e.message); endCall('Something went wrong starting the call. Please try again.', true); }
  }
  async function beginOffer(c, restart) {
    if (!restart) { await makePc(c); }
    var pc = c.pc;
    if (restart) c.rs++;
    var off = await pc.createOffer(restart ? { iceRestart: true } : {});
    await pc.setLocalDescription(off);
    c.offer = { type: 'offer', sdp: pc.localDescription.sdp };
    c.offerSent = 0;
    if (restart) { c.state = 'retry'; render(); }
    sendOffer(c);
    clearInterval(c.timers.resend);
    c.timers.resend = setInterval(function () { if (call !== c || c.answeredRs >= c.rs) { clearInterval(c.timers.resend); return; } sendOffer(c); }, 3500);
    if (!restart) setT(c, 'noanswer', function () { if (c.answeredRs < 0) endCall(c.peer + ' did not answer. They may not have the app open yet.', true); }, 45000);
  }
  function sendOffer(c) {
    c.offerSent++;
    send(c.peer, { t: 'offer', cid: c.cid, rs: c.rs, relay: c.relay, video: c.video, sdp: c.offer.sdp, c: c.outAll.slice(0, 20) });
  }
  async function onAnswer(c, env) {
    if (c.role !== 'caller' || env.cid !== c.cid) return;
    addRemoteCands(c, env.c);
    if ((env.rs || 0) !== c.rs || c.answeredRs >= c.rs) return;
    if (!c.pc || c.pc.signalingState !== 'have-local-offer') return;
    c.answeredRs = c.rs;
    clearInterval(c.timers.resend);
    clearTimeout(c.timers.noanswer);
    try { await c.pc.setRemoteDescription({ type: 'answer', sdp: env.sdp }); } catch (e) { log('answer error ' + e.message); return; }
    flushPending(c);
    if (c.state === 'calling') c.state = 'connecting';
    render();
    armConnectWatch(c);
  }
  function armConnectWatch(c) {
    setT(c, 'connwatch', function () {
      if (c.state === 'connected') return;
      retryCall(c, 'no connection yet');
    }, 12000);
  }
  function retryCall(c, why) {
    if (call !== c || c.role !== 'caller') return;
    c.tries++;
    log('retry ' + c.tries + ' ' + why);
    if (c.tries === 1 && c.pc && c.pc.signalingState === 'stable') {
      c.state = 'retry'; render();
      beginOffer(c, true).then(function () { armConnectWatch(c); }).catch(function () { retryCall(c, 'restart failed'); });
    } else if (c.tries <= 2) {
      relayCall(c);
    } else {
      endCall('The call could not connect. Check the internet on both phones and try again.', true);
    }
  }
  async function relayCall(c) {
    var peer = c.peer, muted = c.muted, tries = c.tries;
    send(peer, { t: 'bye', cid: c.cid, quiet: true });
    clearTimers(c);
    try { c.pc && c.pc.close(); } catch (e) {}
    ended[c.cid] = 1;
    var n = newCall(peer, 'caller', rand(10), true);
    n.tries = Math.max(tries, 2); n.muted = muted; n.state = 'retry'; n.video = c.video; n.camOff = c.camOff; n.note = c.note; n.facing = c.facing;
    call = n; render();
    try { await beginOffer(n, false); armConnectWatch(n); } catch (e) { endCall('The call could not connect. Please try again.', true); }
  }

  /* callee side */
  function handleOffer(env) {
    var peer = clean(env.from);
    if (ended[env.cid]) return;
    if (call && call.cid === env.cid) {
      var c = call;
      addRemoteCands(c, env.c);
      if (c.role !== 'callee') return;
      if ((env.rs || 0) > c.rs && c.pc && c.accepted) { c.rs = env.rs; reanswer(c, env); return; }
      if (c.state === 'ringing') { c.offerEnv = env; setT(c, 'ringexpire', function () { missed(c); }, 12000); return; }
      if (c.answer && (env.rs || 0) === c.rs) { send(c.peer, { t: 'answer', cid: c.cid, rs: c.rs, sdp: c.answer, c: c.outAll.slice(0, 20) }); }
      return;
    }
    if (call && call.peer !== peer) { send(peer, { t: 'busy', cid: env.cid }); return; }
    var wasAccepted = false;
    if (call && call.peer === peer) { wasAccepted = call.accepted; var old = call; clearTimers(old); try { old.pc && old.pc.close(); } catch (e) {} ended[old.cid] = 1; }
    var n = newCall(peer, 'callee', env.cid, env.relay);
    n.video = !!env.video;
    n.offerEnv = env; n.rs = env.rs || 0;
    call = n;
    addRemoteCands(n, env.c);
    if (wasAccepted) { n.state = 'connecting'; acceptCall(); }
    else {
      n.state = 'ringing'; startRing(); render();
      setT(n, 'ringexpire', function () { missed(n); }, 12000);
    }
  }
  function missed(c) {
    if (call !== c || c.state !== 'ringing') return;
    ended[c.cid] = 1; clearTimers(c); call = null; stopRing();
    uiMsg = 'Missed call from ' + c.peer + '.'; render();
  }
  async function acceptCall(audioOnly) {
    var c = call;
    if (!c || c.role !== 'callee') return;
    unlockAudio();
    stopRing(); clearTimeout(c.timers.ringexpire);
    c.accepted = true; c.state = 'connecting'; uiMsg = ''; render();
    try { await getMic(); } catch (e) { send(c.peer, { t: 'bye', cid: c.cid }); endCall(micErrorText(e), false); return; }
    if (call !== c) return;
    if (audioOnly) { c.video = false; c.note = 'You answered with voice only.'; }
    else await prepareVideo(c);
    if (call !== c) return;
    try {
      var pc = await makePc(c);
      await pc.setRemoteDescription({ type: 'offer', sdp: c.offerEnv.sdp });
      if (!c.video) pc.getTransceivers().forEach(function (tr) { if (tr.receiver && tr.receiver.track && tr.receiver.track.kind === 'video') { try { tr.direction = 'inactive'; } catch (e) {} } });
      flushPending(c);
      var ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      c.answer = pc.localDescription.sdp;
      send(c.peer, { t: 'answer', cid: c.cid, rs: c.rs, sdp: c.answer, c: c.outAll.slice(0, 20) });
      setT(c, 'ansresend', function () { if (c.state !== 'connected') send(c.peer, { t: 'answer', cid: c.cid, rs: c.rs, sdp: c.answer, c: c.outAll.slice(0, 20) }); }, 4000);
      setT(c, 'calleewatch', function () { if (c.state !== 'connected') { c.state = 'retry'; render(); } }, 14000);
    } catch (e) { log('accept error ' + e.message); endCall('Something went wrong answering the call.', true); }
  }
  async function reanswer(c, env) {
    try {
      c.state = 'retry'; render();
      await c.pc.setRemoteDescription({ type: 'offer', sdp: env.sdp });
      flushPending(c);
      var ans = await c.pc.createAnswer();
      await c.pc.setLocalDescription(ans);
      c.answer = c.pc.localDescription.sdp;
      send(c.peer, { t: 'answer', cid: c.cid, rs: c.rs, sdp: c.answer, c: c.outAll.slice(0, 20) });
    } catch (e) { log('reanswer error ' + e.message); }
  }

  function handleSignal(env, via) {
    var t = env.t;
    if (t === 'offer') return handleOffer(env);
    if (t === 'answer') { if (call && call.cid === env.cid) return onAnswer(call, env); return; }
    if (t === 'ice') { if (call && call.cid === env.cid) addRemoteCands(call, env.c); return; }
    if (t === 'bye') {
      ended[env.cid] = 1;
      if (call && call.cid === env.cid && !env.quiet) {
        var who = call.peer, was = call.state;
        endCall(was === 'ringing' ? 'Missed call from ' + who + '.' : who + ' ended the call.', false);
      }
      return;
    }
    if (t === 'busy') { if (call && call.cid === env.cid) endCall(call.peer + ' is on another call. Try again soon.', false); return; }
  }

  function icestate(c, pc) {
    if (call !== c || c.pc !== pc) return;
    var ic = pc.iceConnectionState, cs = pc.connectionState;
    if (ic === 'connected' || ic === 'completed' || cs === 'connected') {
      clearTimeout(c.timers.disc); clearTimeout(c.timers.connwatch); clearTimeout(c.timers.calleewatch);
      if (c.state !== 'connected') {
        c.state = 'connected'; c.connectedAt = c.connectedAt || Date.now(); uiMsg = '';
        if (c.video) capVideo(c);
        saveContact(c.peer); startTick(); lockWake(); render();
      }
    } else if (ic === 'disconnected') {
      clearTimeout(c.timers.disc);
      c.timers.disc = setTimeout(function () { if (call === c && c.pc === pc && pc.iceConnectionState !== 'connected') { c.state = 'retry'; render(); if (c.role === 'caller') retryCall(c, 'disconnected'); } }, 5000);
    } else if (ic === 'failed') {
      c.state = 'retry'; render();
      if (c.role === 'caller') retryCall(c, 'failed');
    }
  }

  function endCall(text, tellPeer) {
    var c = call;
    if (!c) return;
    ended[c.cid] = 1;
    if (tellPeer) { var peer = c.peer, cid = c.cid; send(peer, { t: 'bye', cid: cid }); setTimeout(function () { send(peer, { t: 'bye', cid: cid }); }, 900); }
    clearTimers(c);
    try { c.pc && c.pc.close(); } catch (e) {}
    call = null;
    stopRing(); stopTick(); unlockWake(); stopMic(); stopCam();
    $('stage').hidden = true;
    $('remoteAudio').srcObject = null;
    uiMsg = text || 'Call ended.';
    document.title = 'Coffeebreak SIM 3';
    render();
  }

  /* quality readout */
  async function readStats() {
    var c = call;
    if (!c || !c.pc || (c.state !== 'connected' && c.state !== 'retry' && c.state !== 'connecting')) return;
    try {
      var rep = await c.pc.getStats();
      var pair = null, locals = {}, remotes = {}, inb = null, vin = null, tr = null;
      rep.forEach(function (s) {
        if (s.type === 'transport' && s.selectedCandidatePairId) tr = s;
        if (s.type === 'local-candidate') locals[s.id] = s;
        if (s.type === 'remote-candidate') remotes[s.id] = s;
        if (s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) inb = s;
        if (s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) vin = s;
      });
      rep.forEach(function (s) { if (s.type === 'candidate-pair' && ((tr && s.id === tr.selectedCandidatePairId) || (!tr && s.state === 'succeeded' && s.nominated))) pair = s; });
      var st = c.stats;
      if (pair) {
        st.rtt = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : st.rtt;
        var l = locals[pair.localCandidateId] || {}, r = remotes[pair.remoteCandidateId] || {};
        st.relay = l.candidateType === 'relay' || r.candidateType === 'relay';
        st.net = l.networkType || st.net;
      }
      if (inb) { st.recvPrev = st.recv; st.recv = inb.packetsReceived; st.lost = inb.packetsLost; st.jitter = inb.jitter; st.flowing = st.recvPrev != null && st.recv > st.recvPrev; }
      if (vin) { st.vPrev = st.vframes; st.vframes = vin.framesDecoded || 0; st.vflow = st.vPrev != null && st.vframes > st.vPrev; }
      render();
    } catch (e) {}
  }
  function qualityText(c) {
    var s = c.stats;
    if (c.state !== 'connected') return '';
    var parts = [];
    if (s.rtt != null) {
      var q = s.rtt < 150 ? 'Good' : s.rtt < 350 ? 'Fair' : 'Weak';
      parts.push('Quality ' + q + ', delay ' + s.rtt + ' ms');
    }
    if (s.recv != null) parts.push(s.flowing === false ? 'No voice arriving right now' : 'Voice is arriving');
    if (c.video && s.vframes != null) parts.push(s.vflow === false ? 'No picture arriving right now' : 'Picture is arriving');
    if (s.relay !== undefined) parts.push(s.relay ? 'Through the mobile data relay' : 'Direct path');
    if (s.net === 'wifi') parts.push('on WiFi'); else if (s.net === 'cellular') parts.push('on mobile data');
    return parts.join('. ');
  }

  /* timers, wake lock, ringtone */
  function startTick() { stopTick(); tickTimer = setInterval(render, 1000); statTimer = setInterval(readStats, 2000); }
  function stopTick() { clearInterval(tickTimer); clearInterval(statTimer); tickTimer = null; statTimer = null; }
  async function lockWake() { try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) {} }
  function unlockWake() { try { if (wake) wake.release(); } catch (e) {} wake = null; }
  function unlockAudio() {
    try {
      if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
    } catch (e) {}
    var a = $('remoteAudio'); if (a && a.srcObject && a.paused) { var p = a.play(); if (p && p.catch) p.catch(function () {}); }
  }
  function beep(freq, t0, dur) {
    var o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = freq; o.connect(g); g.connect(ac.destination);
    g.gain.setValueAtTime(0.0001, ac.currentTime + t0);
    g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t0 + dur);
    o.start(ac.currentTime + t0); o.stop(ac.currentTime + t0 + dur + 0.05);
  }
  function startRing() {
    stopRing();
    var go = function () {
      try { if (ac && ac.state === 'running') { beep(880, 0, 0.35); beep(660, 0.45, 0.35); } } catch (e) {}
      try { if (navigator.vibrate) navigator.vibrate([400, 200, 400]); } catch (e) {}
      document.title = (document.title.indexOf('Incoming') === 0) ? 'Coffeebreak SIM 3' : 'Incoming call';
    };
    go(); ringIv = setInterval(go, 2000);
  }
  function stopRing() { clearInterval(ringIv); ringIv = null; document.title = 'Coffeebreak SIM 3'; }
  document.addEventListener('pointerdown', unlockAudio);

  /* ---------- contacts ---------- */
  function getContacts() { try { return JSON.parse(LS.getItem('cbsim3.contacts') || '[]').filter(Boolean); } catch (e) { return []; } }
  function setContacts(l) { LS.setItem('cbsim3.contacts', JSON.stringify(l)); }
  function saveContact(n) { var l = getContacts(); if (n && l.indexOf(n) < 0) { l.push(n); setContacts(l); renderContacts(); } }
  function renderContacts() {
    var box = $('contacts'); box.innerHTML = '';
    getContacts().forEach(function (n) {
      var w = document.createElement('span'); w.className = 'contact';
      var b = document.createElement('button'); b.type = 'button'; b.textContent = n;
      b.addEventListener('click', function () { $('dialInput').value = n; render(); });
      var x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '\u00d7'; x.setAttribute('aria-label', 'Remove ' + n);
      x.addEventListener('click', function () { setContacts(getContacts().filter(function (z) { return z !== n; })); renderContacts(); });
      w.appendChild(b); w.appendChild(x); box.appendChild(w);
    });
  }

  /* ---------- screen ---------- */
  function fmt(ms) { var s = Math.floor(ms / 1000), m = Math.floor(s / 60); s = s % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
  function render() {
    var st = $('status'), tx = $('statusText'), main = $('mainBtn'), row = $('secondRow');
    var mute = $('muteBtn'), decl = $('declineBtn'), info = $('callInfo');
    var vb = $('videoBtn'), ab = $('audioAnsBtn'), vrow = $('videoRow'), camb = $('camBtn'), swb = $('switchBtn'), stage = $('stage');
    var cls = 's-connecting', text = 'Connecting';
    var up = routes.a.up || routes.b.up;
    main.className = 'big call'; main.textContent = 'Call'; $('callRow').classList.toggle('single', !!call);
    row.hidden = true; mute.hidden = true; decl.hidden = true; info.hidden = true; ab.hidden = true; vrow.hidden = true; vb.hidden = !!call; stage.hidden = true;
    $('simcard').hidden = !!(call && call.video && call.state !== 'ringing');
    $('app').classList.remove('wide'); $('app').classList.toggle('invideo', !!(call && call.video && call.state !== 'ringing'));
    $('dial').hidden = !!call;
    if (!me) { text = 'Connecting'; }
    else if (!call) {
      if (up) { cls = 's-ready'; text = 'Connected. Ready to call'; } else { cls = 's-connecting'; text = 'Connecting'; }
    } else {
      info.hidden = false;
      $('callWho').textContent = call.peer;
      var line = '';
      if (call.state === 'calling') { cls = 's-calling'; text = 'Calling ' + call.peer; line = 'Waiting for them to answer'; main.className = 'big hang'; main.textContent = 'Hang up'; }
      else if (call.state === 'ringing') { cls = 's-ringing'; text = call.video ? 'Incoming video call' : 'Incoming call'; line = call.peer + (call.video ? ' is calling you with video' : ' is calling you'); main.className = 'big answer'; main.textContent = call.video ? 'Answer with video' : 'Answer'; row.hidden = false; decl.hidden = false; decl.textContent = 'Decline'; ab.hidden = !call.video; }
      else if (call.state === 'connecting') { cls = 's-connecting'; text = 'Connecting'; line = 'Setting up the call'; main.className = 'big hang'; main.textContent = 'Hang up'; }
      else if (call.state === 'retry') { cls = 's-retry'; text = 'Trying again'; line = 'The line was weak. Trying another way'; main.className = 'big hang'; main.textContent = 'Hang up'; }
      else if (call.state === 'connected') { cls = 's-connected'; text = 'Connected ' + fmt(Date.now() - call.connectedAt); line = (call.video ? 'You are on a video call' : 'You are on a call') + (call.note ? '. ' + call.note.replace(/\.$/, '') : ''); main.className = 'big hang'; main.textContent = 'Hang up'; row.hidden = false; mute.hidden = false; mute.textContent = call.muted ? 'Unmute' : 'Mute'; mute.className = 'mid' + (call.muted ? ' on' : ''); }
      if (call.video && call.state !== 'ringing') {
        stage.hidden = false;
        if (window.innerWidth >= 700) $('app').classList.add('wide');
        $('stagePh').hidden = !!call.remoteVideo;
        $('stagePh').textContent = call.state === 'connected' ? 'They are not sharing a camera' : 'Waiting for their camera';
        $('localVideo').hidden = !cam;
        $('camOffTag').hidden = !call.camOff;
        if (call.state === 'connecting' || call.state === 'retry' || call.state === 'connected') {
          vrow.hidden = false;
          camb.textContent = call.camOff ? 'Turn camera on' : 'Turn camera off';
          camb.className = 'mid' + (call.camOff ? ' on' : '');
          swb.hidden = !(cam && (isPhoneLike || camCount > 1));
        }
      } else if (call.note && call.state !== 'ringing' && call.state !== 'connected') line = line + (line ? '. ' : '') + call.note;
      $('callLine').textContent = line;
      $('callQuality').textContent = qualityText(call);
    }
    st.className = 'status ' + cls; tx.textContent = text;
    var ra = routes.a.up ? 'on' : (routes.a.note ? routes.a.note : 'trying again'), rb = routes.b.up ? 'on' : 'trying again';
    $('routes').textContent = me ? 'Call lines: Line 1 ' + ra + '. Line 2 ' + rb + '. If one stops, the other keeps working.' : 'Choose a SIM name to start';
    $('simName').textContent = me || '-';
    $('msg').textContent = uiMsg;
  }

  /* ---------- panels ---------- */
  var panels = ['panelTest', 'panelWifi', 'panelAbout', 'panelName'];
  function openPanel(id) {
    panels.forEach(function (p) { $(p).hidden = p !== id; });
    if (id) $(id).scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (id === 'panelWifi') { wifiCheck(); clearInterval(wifiIv); wifiIv = setInterval(wifiCheck, 20000); } else { clearInterval(wifiIv); }
  }
  var wifiIv = null;
  document.querySelectorAll('.closeBtn').forEach(function (b) { b.addEventListener('click', function () { openPanel(null); }); });
  $('testBtn').addEventListener('click', function () { openPanel('panelTest'); });
  $('wifiBtn').addEventListener('click', function () { openPanel('panelWifi'); });
  $('aboutBtn').addEventListener('click', function () { openPanel('panelAbout'); });
  $('renameBtn').addEventListener('click', function () { if (call) return; $('nameInput').value = me; openPanel('panelName'); });
  $('nameSave').addEventListener('click', function () {
    var n = clean($('nameInput').value);
    if (!n) { $('nameInput').focus(); return; }
    me = n; LS.setItem('cbsim3.me', me);
    openPanel(null); sigStart(); render();
  });
  $('nameInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('nameSave').click(); });

  /* main buttons */
  $('videoBtn').addEventListener('click', function () { if (!call) startCall($('dialInput').value, true); });
  $('audioAnsBtn').addEventListener('click', function () { if (call && call.state === 'ringing') acceptCall(true); });
  $('camBtn').addEventListener('click', function () {
    if (!call || !call.video || !cam) return; call.camOff = !call.camOff;
    cam.getVideoTracks().forEach(function (t) { t.enabled = !call.camOff; });
    render();
  });
  $('switchBtn').addEventListener('click', switchCamera);
  $('mainBtn').addEventListener('click', function () {
    if (!call) { startCall($('dialInput').value); return; }
    if (call.state === 'ringing') { acceptCall(); return; }
    endCall('Call ended.', true);
  });
  $('declineBtn').addEventListener('click', function () { if (call) endCall('Call declined.', true); });
  $('muteBtn').addEventListener('click', function () {
    if (!call) return; call.muted = !call.muted;
    if (mic) mic.getAudioTracks().forEach(function (t) { t.enabled = !call.muted; });
    render();
  });
  $('dialInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('mainBtn').click(); });
  window.addEventListener('pagehide', function () { if (call) { send(call.peer, { t: 'bye', cid: call.cid }); } });

  /* ---------- network check for the WiFi screen ---------- */
  async function measure() {
    var out = { type: '', delay: null, mbps: null };
    var nc = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    var net = call && call.stats && call.stats.net;
    if (nc && nc.type === 'wifi' || net === 'wifi') out.type = 'WiFi';
    else if (nc && nc.type === 'cellular' || net === 'cellular') out.type = 'Mobile data';
    else if (nc && nc.type === 'ethernet') out.type = 'Wired network';
    else if (nc && nc.effectiveType) out.type = 'Online. This device does not say if it is WiFi or mobile data (speed class ' + nc.effectiveType + ')';
    else out.type = navigator.onLine ? 'Online. This device does not say if it is WiFi or mobile data' : 'Offline';
    if (!navigator.onLine) return out;
    var times = [];
    for (var i = 0; i < 4; i++) {
      var t0 = performance.now();
      try { var r = await withTimeout(fetch('ping.txt?t=' + Date.now() + i, { cache: 'no-store' }).then(function (x) { return x.text(); }), 5000, null); if (r !== null) times.push(performance.now() - t0); } catch (e) {}
    }
    if (times.length) { times.sort(function (a, b) { return a - b; }); out.delay = Math.round(times[Math.floor(times.length / 2)]); }
    try {
      var s0 = performance.now();
      var buf = await withTimeout(fetch('speed.bin?t=' + Date.now(), { cache: 'no-store' }).then(function (x) { return x.arrayBuffer(); }), 12000, null);
      if (buf) { var sec = (performance.now() - s0) / 1000; out.mbps = Math.max(0.05, (buf.byteLength * 8 / sec / 1e6)); }
    } catch (e) {}
    return out;
  }
  var wifiBusy = false;
  async function wifiCheck() {
    if (wifiBusy) return; wifiBusy = true;
    $('wfAgain').disabled = true;
    try {
      var m = await measure();
      $('wfType').textContent = m.type;
      $('wfSpeed').textContent = m.mbps == null ? 'Could not measure' : 'About ' + (m.mbps >= 10 ? Math.round(m.mbps) : m.mbps.toFixed(1)) + ' Mbps (' + (m.mbps >= 5 ? 'fast' : m.mbps >= 1 ? 'good' : m.mbps >= 0.3 ? 'slow' : 'very slow') + ')';
      $('wfDelay').textContent = m.delay == null ? 'Could not measure' : m.delay + ' ms (' + (m.delay < 120 ? 'quick' : m.delay < 300 ? 'fine for calls' : 'slow') + ')';
      var v;
      if (m.delay == null && m.mbps == null) v = 'No. The internet cannot be reached right now';
      else if ((m.delay != null && m.delay > 600) || (m.mbps != null && m.mbps < 0.2)) v = 'Weak. Calls may break up. Move closer to the router or phone';
      else if ((m.delay != null && m.delay > 300) || (m.mbps != null && m.mbps < 0.5)) v = 'Fair. Calls should work but may lag a little';
      else v = 'Yes. This is good enough for voice calls';
      $('wfVerdict').textContent = v;
    } finally { wifiBusy = false; $('wfAgain').disabled = false; }
  }
  $('wfAgain').addEventListener('click', wifiCheck);
  if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', function () { if (!$('panelWifi').hidden) wifiCheck(); });

  /* ---------- self test ---------- */
  function addTest(title) { var li = document.createElement('li'); li.className = 'wait'; li.innerHTML = '<b></b><span>Checking</span>'; li.firstChild.textContent = title; $('testList').appendChild(li); return li; }
  function setTest(li, ok, text) { li.className = ok ? 'ok' : 'bad'; li.lastChild.textContent = text; }
  function selfPing(route) {
    return new Promise(function (resolve) {
      var id0 = rand(10), done = false;
      var fin = function (v) { if (!done) { done = true; delete selfTests[id0]; resolve(v); } };
      selfTests[id0] = function (via) { if (via === route) fin(true); };
      var env = { t: 'selftest', id: rand(14), id0: id0, from: me, to: me, ts: Date.now() };
      if (route === 'a') { if (!wsSend(me, env)) return fin(false); }
      else { ntfySend(me, env).then(function (ok) { if (!ok) fin(false); }); }
      setTimeout(function () { fin(false); }, 8000);
    });
  }
  async function iceProbe(list, relayOnly) {
    var pc = new RTCPeerConnection({ iceServers: list, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
    var found = { relay: false, srflx: false, host: false };
    pc.createDataChannel('t');
    pc.onicecandidate = function (e) { if (e.candidate) { var m = / typ (\w+)/.exec(e.candidate.candidate); if (m) found[m[1]] = true; } };
    try { await pc.setLocalDescription(await pc.createOffer()); } catch (e) { pc.close(); return found; }
    var t0 = Date.now();
    while (Date.now() - t0 < 9000) {
      if (relayOnly ? found.relay : (found.srflx || pc.iceGatheringState === 'complete')) break;
      if (pc.iceGatheringState === 'complete') break;
      await sleep(200);
    }
    pc.close();
    return found;
  }
  var testing = false;
  async function runTest() {
    if (testing) return;
    if (call) { $('testSummary').textContent = 'Finish your call first, then run the test.'; return; }
    if (!me) { $('testSummary').textContent = 'Choose a SIM name first.'; return; }
    testing = true; $('runTest').disabled = true;
    $('testList').innerHTML = ''; $('testSummary').textContent = 'Testing. This takes about ten seconds.';
    var res = {};
    var l1 = addTest('Microphone');
    try { var s = await getMic(); var live = s.getAudioTracks().some(function (t) { return t.readyState === 'live'; }); stopMic(); res.mic = live; setTest(l1, live, live ? 'The microphone works.' : 'The microphone did not start.'); }
    catch (e) { res.mic = false; setTest(l1, false, micErrorText(e)); }
    var lc = addTest('Camera');
    var cr = await getCam('user');
    if (cr.stream) { res.cam = cr.stream.getVideoTracks().some(function (t) { return t.readyState === 'live'; }); setTest(lc, res.cam, res.cam ? 'The camera works. Video calls are ready.' : 'The camera did not start. Calls will be voice only.'); }
    else { res.cam = false; setTest(lc, false, camErrorText(cr.error) + ' Video calls will fall back to voice only.'); }
    stopCam();
    var l2 = addTest('Call line 1');
    var l3 = addTest('Call line 2');
    var pa = selfPing('a').then(function (ok) { res.a = ok; setTest(l2, ok, ok ? 'Line 1 works. A test message went out and came back.' : (routes.a.up ? 'Line 1 is connected but the test message did not come back.' : 'Line 1 is not connected. ' + (routes.a.note ? 'This SIM name looks open on another device. ' : '') + 'Line 2 can still carry calls.')); });
    var pb = selfPing('b').then(function (ok) { res.b = ok; setTest(l3, ok, ok ? 'Line 2 works. A test message went out and came back.' : 'Line 2 did not answer. Line 1 can still carry calls.'); });
    var l4 = addTest('Direct path and mobile data relay');
    var list = await getIce();
    var turnListed = hasTurn(list);
    var f1 = await iceProbe(list, false);
    var f2 = turnListed ? await iceProbe(list, true) : { relay: false };
    res.direct = f1.srflx || f1.host; res.turn = f2.relay;
    var txt = (f1.srflx ? 'A direct path was found for WiFi calls. ' : 'No direct path was found on this network, so calls here will use the relay. ') + (f2.relay ? 'The mobile data relay answered, so calls can work over mobile data.' : 'The mobile data relay did not answer, so calls over mobile data may fail.');
    setTest(l4, !!f2.relay, txt);
    await Promise.all([pa, pb]);
    var okLines = res.a || res.b;
    var sum;
    if (!res.mic) sum = 'Fix the microphone first, then test again.';
    else if (!okLines) sum = 'Calls cannot find each other right now. Check the internet and test again.';
    else if (res.a && res.b && res.turn) sum = 'Everything is working. Calls should connect on WiFi and on mobile data.';
    else if (res.turn) sum = 'Calls should connect. One call line is down, so the other one carries it.';
    else sum = 'Calls should connect on WiFi. Calls over mobile data may not.';
    if (res.mic) sum += res.cam ? ' Video calls are ready.' : ' The camera is not available, so video calls will be voice only.';
    $('testSummary').textContent = sum;
    window.__cbTest = res;
    testing = false; $('runTest').disabled = false;
  }
  $('runTest').addEventListener('click', runTest);

  /* ---------- start ---------- */
  renderContacts();
  var dial = clean(params.get('call'));
  if (dial) $('dialInput').value = dial;
  render();
  if (!me) { openPanel('panelName'); }
  else { sigStart(); }
  if (dial && me && params.get('go') === '1') { setTimeout(function () { startCall(dial, params.get('video') === '1'); }, 800); }
  else if (dial && me) { uiMsg = 'Tap Call to ring ' + dial + '.'; render(); }

  window.__cb = { get call() { return call; }, get routes() { return routes; }, get me() { return me; }, runTest: runTest, readStats: readStats };
})();
