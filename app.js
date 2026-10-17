(() => {
  const BASE = "/app/";
  const $ = (id) => document.getElementById(id);

  let scenario = "bike";
  let selected = null;
  let samples = [];
  let menuOpen = false;
  let starter = "What should the rider do next?";
  let askToken = 0;
  let tracks = [];
  let trackToken = 0;
  let sceneLayout = { kind: "straight", sidewalks: true, crosswalk: false, bikeLane: false, label: "Street" };
  let closeCall = null;
  let pausedForCall = false;
  let voiceOn = true;
  let eleven = false;
  let beats = [];
  let mindNodes = [];
  let activeNode = "";
  let currentAudio = null;
  let preloadToken = 0;
  let speakGen = 0;
  let memories = [];
  let listening = false;
  let micReady = false;
  let micPriming = false;
  let recorder = null;
  let recordChunks = [];
  const audioByText = new Map();
  try {
    const stored = JSON.parse(sessionStorage.getItem("takeaway-memories") || "[]");
    if (Array.isArray(stored)) memories = stored;
  } catch { /* ignore */ }
  try { voiceOn = localStorage.getItem("takeaway-voice") !== "0"; } catch { /* ignore */ }

  function proxyUrl(source) {
    return `${BASE}api/proxy?source=${encodeURIComponent(source)}`;
  }

  function playbackSource(s) {
    // Detections belong to the analyzed segment, so the picture and the boxes match.
    return (s && (s.preview_source || s.original_video)) || null;
  }

  const COLORS = {
    person: "#e85d04",
    bicycle: "#f4c430",
    car: "#7ec8e3",
    truck: "#f7f4ef",
    bus: "#c4b5fd",
    motorcycle: "#86efac",
  };

  function frameAt(time) {
    if (!tracks.length) return null;
    let best = tracks[0];
    let bestDist = Math.abs((best.t || 0) - time);
    for (const frame of tracks) {
      const dist = Math.abs((frame.t || 0) - time);
      if (dist < bestDist) {
        best = frame;
        bestDist = dist;
      }
    }
    return best;
  }

  function containRect(canvas, video) {
    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    const cw = canvas.clientWidth || canvas.width;
    const ch = canvas.clientHeight || canvas.height;
    const scale = Math.min(cw / vw, ch / vh);
    const w = vw * scale;
    const h = vh * scale;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  function drawBoxes(canvas, frame, video) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const cssW = canvas.clientWidth || 320;
    const cssH = canvas.clientHeight || 180;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cssW * ratio) || canvas.height !== Math.round(cssH * ratio)) {
      canvas.width = Math.round(cssW * ratio);
      canvas.height = Math.round(cssH * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!frame) return;
    const rect = video && video.videoWidth ? containRect(canvas, video) : { x: 0, y: 0, w: cssW, h: cssH };
    ctx.strokeStyle = "rgba(244,247,243,0.18)";
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
    (frame.objects || []).forEach((obj) => {
      const color = COLORS[obj.label] || "#f4f7f3";
      const x = rect.x + obj.x * rect.w;
      const y = rect.y + obj.y * rect.h;
      const w = Math.max(8, obj.w * rect.w);
      const h = Math.max(8, obj.h * rect.h);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = color;
      ctx.font = "12px DM Sans, sans-serif";
      const tag = obj.label;
      const tw = ctx.measureText(tag).width + 8;
      const labelY = Math.max(rect.y, y - 16);
      ctx.fillRect(x, labelY, tw, 16);
      ctx.fillStyle = "#10231c";
      ctx.fillText(tag, x + 4, labelY + 12);
      const scale = Math.max(0.45, Math.min(2.4, h / 22));
      drawActor(ctx, obj.label, x + w / 2, y + h, scale);
    });
  }

  function fitCanvas(canvas) {
    const cssW = canvas.clientWidth || 640;
    const cssH = canvas.clientHeight || 280;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cssW * ratio) || canvas.height !== Math.round(cssH * ratio)) {
      canvas.width = Math.round(cssW * ratio);
      canvas.height = Math.round(cssH * ratio);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx, w: cssW, h: cssH };
  }

  function readLayout(scene, classes) {
    const text = (scene || "").toLowerCase();
    if (scenario === "highway" || text.includes("highway")) {
      return { kind: "highway", sidewalks: false, crosswalk: false, bikeLane: false, label: "Highway" };
    }
    const seen = new Set(classes || []);
    const lights = seen.has("traffic light") || text.includes("traffic light");
    const crossing = /crosswalk|intersection|crossing/.test(text);
    const bikeLane = /bike lane|bicycle lane/.test(text);
    const blocked = /block|parked in|obstruct|sitting in the lane|parked on/.test(text);
    const narrow = /narrow/.test(text);
    const sidewalks = /sidewalk|curb|pedestrian/.test(text) || crossing || bikeLane;
    let kind = "straight";
    if (bikeLane) kind = "bike-lane";
    else if (blocked && !crossing) kind = "blocked";
    else if (crossing || lights) kind = "intersection";
    else if (blocked) kind = "blocked";
    else if (narrow) kind = "narrow";
    const labels = {
      intersection: "Intersection",
      blocked: "Blocked lane",
      "bike-lane": "Bike lane",
      narrow: "Narrow street",
      straight: "Straight street",
    };
    return {
      kind,
      sidewalks,
      crosswalk: crossing || kind === "intersection",
      bikeLane: bikeLane || kind === "bike-lane",
      label: labels[kind],
    };
  }

  function roadSlice(w, h, depth, narrow) {
    const top = h * 0.08;
    const bottom = h * 0.94;
    const y = top + depth * (bottom - top);
    const halfFar = w * (narrow ? 0.09 : 0.16);
    const halfNear = w * (narrow ? 0.24 : layoutWidth());
    const half = halfFar + (halfNear - halfFar) * depth;
    return { y, left: w / 2 - half, right: w / 2 + half };
  }

  function layoutWidth() {
    if (sceneLayout.kind === "blocked") return 0.3;
    if (sceneLayout.kind === "narrow") return 0.26;
    return 0.42;
  }

  function actorsFrom(frame) {
    return (frame && frame.objects ? frame.objects : [])
      .map((obj) => {
        const foot = Math.min(1, Math.max(0, obj.y + obj.h));
        const depth = Math.min(1, Math.max(0.08, (foot - 0.25) / 0.75));
        const across = Math.min(1, Math.max(0, obj.x + obj.w / 2));
        return { ...obj, depth, across };
      })
      .sort((a, b) => a.depth - b.depth);
  }

  function paintCrosswalk(ctx, x, y, horizontal) {
    ctx.strokeStyle = "rgba(244,247,243,0.9)";
    ctx.lineWidth = 3;
    for (let i = 0; i < 5; i += 1) {
      ctx.beginPath();
      if (horizontal) {
        ctx.moveTo(x + i * 14, y);
        ctx.lineTo(x + i * 14, y + 14);
      } else {
        ctx.moveTo(x, y + i * 12);
        ctx.lineTo(x + 16, y + i * 12);
      }
      ctx.stroke();
    }
  }

  function drawIntersection(ctx, w, h, actors) {
    ctx.fillStyle = sceneLayout.sidewalks ? "#8d8474" : "#1c3a2e";
    ctx.fillRect(0, 0, w, h);
    const arm = Math.min(w, h) * 0.34;
    ctx.fillStyle = "#3d4740";
    ctx.fillRect(w / 2 - arm / 2, 0, arm, h);
    ctx.fillRect(0, h / 2 - arm / 2, w, arm);
    ctx.strokeStyle = "rgba(244,247,243,0.35)";
    ctx.lineWidth = 2;
    ctx.strokeRect(w / 2 - arm / 2, h / 2 - arm / 2, arm, arm);
    if (sceneLayout.crosswalk) {
      paintCrosswalk(ctx, w / 2 - 28, h / 2 + arm / 2 + 6, false);
      paintCrosswalk(ctx, w / 2 - 28, h / 2 - arm / 2 - 22, false);
      paintCrosswalk(ctx, w / 2 + arm / 2 + 8, h / 2 - 24, true);
      paintCrosswalk(ctx, w / 2 - arm / 2 - 28, h / 2 - 24, true);
    }
    actors.forEach((obj) => {
      let x = obj.across * w;
      let y = (obj.y + obj.h) * h;
      const edge = obj.across < 0.16 || obj.across > 0.84;
      if (obj.label === "person" && edge && sceneLayout.sidewalks) {
        x = obj.across < 0.5 ? w * 0.1 : w * 0.9;
        y = h * (0.18 + (obj.y + obj.h) * 0.64);
      }
      drawActor(ctx, obj.label, x, y, 0.65 + obj.depth * 0.55);
    });
  }

  function drawCorridor(ctx, w, h, actors) {
    const narrow = sceneLayout.kind === "narrow" || sceneLayout.kind === "blocked";
    ctx.fillStyle = "#1c3a2e";
    ctx.fillRect(0, 0, w, h);
    const far = roadSlice(w, h, 0, narrow);
    const near = roadSlice(w, h, 1, narrow);
    if (sceneLayout.sidewalks) {
      ctx.fillStyle = "#8d8474";
      ctx.beginPath();
      ctx.moveTo(0, far.y);
      ctx.lineTo(w, far.y);
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.fill();
    }
    ctx.fillStyle = "#3d4740";
    ctx.beginPath();
    ctx.moveTo(far.left, far.y);
    ctx.lineTo(far.right, far.y);
    ctx.lineTo(near.right, near.y);
    ctx.lineTo(near.left, near.y);
    ctx.fill();
    if (sceneLayout.bikeLane) {
      ctx.fillStyle = "rgba(232,93,4,0.38)";
      ctx.beginPath();
      const lane = 0.7;
      ctx.moveTo(far.left + (far.right - far.left) * lane, far.y);
      ctx.lineTo(far.right, far.y);
      ctx.lineTo(near.right, near.y);
      ctx.lineTo(near.left + (near.right - near.left) * lane, near.y);
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(244,247,243,0.85)";
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 12]);
    ctx.beginPath();
    ctx.moveTo(w / 2, far.y + 8);
    ctx.lineTo(w / 2, near.y - 8);
    ctx.stroke();
    ctx.setLineDash([]);
    if (sceneLayout.crosswalk) {
      const band = roadSlice(w, h, 0.78, narrow);
      paintCrosswalk(ctx, band.left + 16, band.y, true);
    }
    actors.forEach((obj) => {
      const row = roadSlice(w, h, obj.depth, narrow);
      let across = obj.across;
      if (obj.label === "person" && sceneLayout.sidewalks && (across < 0.18 || across > 0.82)) {
        const x = across < 0.5 ? row.left - 18 : row.right + 18;
        drawActor(ctx, obj.label, x, row.y, 0.55 + obj.depth * 0.7);
        return;
      }
      const x = row.left + across * (row.right - row.left);
      drawActor(ctx, obj.label, x, row.y, 0.55 + obj.depth * 0.9);
    });
  }

  function drawStreet(canvas, frame) {
    if (!canvas) return;
    const { ctx, w, h } = fitCanvas(canvas);
    const actors = actorsFrom(frame);
    if (sceneLayout.kind === "intersection") drawIntersection(ctx, w, h, actors);
    else drawCorridor(ctx, w, h, actors);
  }

  function drawActor(ctx, label, x, y, scale) {
    const color = COLORS[label] || "#f4f7f3";
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = color;
    ctx.strokeStyle = "#10231c";
    ctx.lineWidth = 1.5;
    if (label === "person") {
      ctx.beginPath();
      ctx.arc(0, -16, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-3, -11, 6, 12);
      ctx.fillRect(-7, -2, 5, 3);
      ctx.fillRect(2, -2, 5, 3);
    } else if (label === "bicycle" || label === "motorcycle") {
      ctx.beginPath();
      ctx.arc(-8, 0, 5, 0, Math.PI * 2);
      ctx.arc(8, 0, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-8, 0);
      ctx.lineTo(0, -8);
      ctx.lineTo(8, 0);
      ctx.stroke();
    } else {
      const len = label === "bus" ? 34 : label === "truck" ? 28 : 20;
      const tall = label === "truck" || label === "bus" ? 12 : 10;
      ctx.fillRect(-len / 2, -tall, len, tall);
      ctx.fillStyle = "rgba(16,35,28,0.35)";
      ctx.fillRect(-len / 2 + 3, -tall + 2, len * 0.35, tall - 4);
    }
    ctx.restore();
  }

  function describe(frame) {
    const counts = {};
    (frame && frame.objects || []).forEach((obj) => {
      counts[obj.label] = (counts[obj.label] || 0) + 1;
    });
    const names = {
      person: ["person", "people"],
      bicycle: ["bicycle", "bicycles"],
      car: ["car", "cars"],
      truck: ["truck", "trucks"],
      bus: ["bus", "buses"],
      motorcycle: ["motorcycle", "motorcycles"],
    };
    return Object.keys(names)
      .filter((label) => counts[label])
      .map((label) => `${counts[label]} ${names[label][counts[label] > 1 ? 1 : 0]}`)
      .join(" · ");
  }

  function sideGap(person, vehicle) {
    const depth = Math.abs((person.y + person.h) - (vehicle.y + vehicle.h));
    if (depth > 0.06 || person.h < 0.04 || vehicle.h < 0.04) return null;
    const personRight = person.x + person.w;
    const vehicleRight = vehicle.x + vehicle.w;
    return Math.max(0, Math.max(person.x - vehicleRight, vehicle.x - personRight));
  }

  function findCloseCall(frames) {
    const people = new Set(["person", "bicycle"]);
    const vehicles = new Set(["car", "truck", "bus", "motorcycle"]);
    const rows = [];
    (frames || []).forEach((frame) => {
      const folks = (frame.objects || []).filter((obj) => people.has(obj.label));
      const fleet = (frame.objects || []).filter((obj) => vehicles.has(obj.label));
      let best = null;
      folks.forEach((person) => {
        fleet.forEach((vehicle) => {
          const gap = sideGap(person, vehicle);
          if (gap == null) return;
          if (!best || gap < best.gap) {
            best = { t: frame.t || 0, gap, person: person.label, vehicle: vehicle.label };
          }
        });
      });
      if (best) rows.push(best);
    });
    if (!rows.length) return null;
    const locals = rows.filter((row, index) => {
      if (row.t < 0.4) return false;
      const prev = index ? rows[index - 1].gap : 9;
      const next = index + 1 < rows.length ? rows[index + 1].gap : 9;
      return row.gap <= prev && row.gap <= next;
    });
    const pool = locals.length ? locals : rows.filter((row) => row.t >= 0.4);
    const chosen = (pool.length ? pool : rows).reduce((a, b) => (b.gap < a.gap ? b : a));
    let call = "Pass";
    if (chosen.gap < 0.03) call = "Stop";
    else if (chosen.gap < 0.12) call = "Wait";
    return { ...chosen, call };
  }

  function showCloseCall(call) {
    const label = $("layoutLabel");
    const look = $("look");
    const move = $("move");
    if (!call) {
      if (label) label.textContent = "No close call";
      return;
    }
    const when = `${Number(call.t).toFixed(1)}s`;
    if (label) label.textContent = `${call.call} · ${when}`;
    if (look && look.dataset.asked !== "1") {
      look.textContent = `${call.person} is nearest a ${call.vehicle}.`;
    }
    if (move && move.dataset.asked !== "1") {
      move.textContent = call.call === "Stop"
        ? "Stop. They meet in the frame."
        : call.call === "Wait"
          ? "Wait until the gap opens."
          : "The gap is open. You can pass.";
    }
    const mark = $("closeMark");
    const player = $("player");
    if (mark) {
      mark.hidden = false;
      mark.textContent = call.call;
      const duration = player && player.duration && Number.isFinite(player.duration) ? player.duration : 0;
      const ratio = duration ? Math.min(0.96, Math.max(0.04, call.t / duration)) : 0.5;
      mark.style.left = `${ratio * 100}%`;
    }
  }

  function jumpToCloseCall() {
    const player = $("player");
    if (!player || !closeCall) return;
    pausedForCall = true;
    player.currentTime = closeCall.t;
    player.pause();
    showPlayOverlay(false);
    showCloseCall(closeCall);
    paintDetections(closeCall.t);
  }

  function paintDetections(time) {
    const player = $("player");
    const frame = frameAt(time == null ? (player && player.currentTime) || 0 : time);
    drawBoxes($("overlay"), frame, player);
    const label = $("layoutLabel");
    if (label) {
      label.textContent = closeCall
        ? `${closeCall.call} · ${Number(closeCall.t).toFixed(1)}s`
        : (sceneLayout.label || "Street");
    }
    const cast = $("cast");
    const who = frame ? (describe(frame) || "No people or vehicles in this moment") : "Reading detections…";
    if (cast) cast.textContent = who;
    if (frame && $("look") && !($("look").dataset.asked === "1")) {
      const line = describe(frame);
      if (line) $("look").textContent = line;
    }
  }

  async function api(path, opts = {}) {
    const url = path.startsWith("http")
      ? path
      : `${BASE}${path.replace(/^\//, "")}`;
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function showPlayOverlay(show) {
    const overlay = $("playOverlay");
    if (overlay) overlay.hidden = !show;
  }

  function setMenuOpen(open) {
    menuOpen = open;
    const btn = $("menuBtn");
    const panel = $("menuPanel");
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (panel) panel.hidden = !open;
  }

  function paintGuide(sample) {
    const look = $("look");
    const move = $("move");
    const avoid = $("avoid");
    if (look) {
      look.dataset.asked = "";
      look.textContent = sample.look || "";
    }
    if (move) move.textContent = sample.move || "";
    if (avoid) avoid.textContent = sample.avoid || "";
  }

  async function loadTracks(source) {
    const token = ++trackToken;
    tracks = [];
    paintDetections(0);
    if (!source) return;
    try {
      const data = await api(`api/tracks?source=${encodeURIComponent(source)}`);
      if (token !== trackToken) return;
      tracks = data.frames || [];
      if (selected) sceneLayout = readLayout(selected.scene, data.classes || []);
      closeCall = findCloseCall(tracks);
      pausedForCall = false;
      showCloseCall(closeCall);
      const player = $("player");
      paintDetections((player && player.currentTime) || 0);
      refreshMind();
    } catch {
      if (token !== trackToken) return;
      const cast = $("cast");
      if (cast) cast.textContent = "No detection track for this clip";
      refreshMind();
    }
  }

  function spokenList(frame) {
    const line = describe(frame);
    return line ? line.replace(/ · /g, ", ") : "an empty stretch of road";
  }

  function peakLine(frames) {
    const counts = {};
    (frames || []).forEach((frame) => {
      const seen = {};
      (frame.objects || []).forEach((obj) => {
        seen[obj.label] = (seen[obj.label] || 0) + 1;
      });
      Object.entries(seen).forEach(([label, count]) => {
        counts[label] = Math.max(counts[label] || 0, count);
      });
    });
    const objects = [];
    Object.entries(counts).forEach(([label, count]) => {
      for (let i = 0; i < count; i += 1) objects.push({ label });
    });
    return spokenList({ objects });
  }

  const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

  function soften(line) {
    return String(line || "").replace(/\b(\d+)\b/g, (raw) => {
      const n = Number(raw);
      return NUMBER_WORDS[n] || raw;
    });
  }

  function memoryPrompt() {
    if (scenario === "highway") {
      return { title: "The highway", say: "What does this highway remind me of?" };
    }
    if (sceneLayout.kind === "bike-lane") {
      return { title: "Your lane", say: "Have I ridden a marked lane with traffic beside me?" };
    }
    if (sceneLayout.kind === "blocked") {
      return { title: "The wait", say: "Have I waited like this, with something parked in my lane?" };
    }
    if (sceneLayout.crosswalk || sceneLayout.kind === "intersection") {
      return { title: "The crossing", say: "What do I remember about a corner full of people?" };
    }
    if (closeCall && closeCall.call === "Pass") {
      return { title: "The gap", say: "When a gap opens in front of me, what do I do?" };
    }
    if (closeCall && closeCall.call === "Stop") {
      return { title: "The stop", say: "What does this stop remind me of?" };
    }
    return { title: "This street", say: "What does this street remind me of?" };
  }

  function cap(text) {
    const line = String(text || "").trim();
    return line ? line.charAt(0).toUpperCase() + line.slice(1) : "";
  }

  function placeWords() {
    const place = (sceneLayout.label || "street").toLowerCase();
    if (place === "highway") return "on a highway";
    if (place === "intersection") return "at an intersection";
    const article = /^[aeiou]/.test(place) ? "an" : "a";
    return `in ${article} ${place}`;
  }

  function myCall() {
    if (!closeCall) return "Nothing pulls me to stop.";
    const person = `a ${closeCall.person}`;
    const vehicle = `a ${closeCall.vehicle}`;
    if (closeCall.call === "Stop") return `I stop. ${cap(`${person} is right against ${vehicle}`)}.`;
    if (closeCall.call === "Wait") return `I wait. ${cap(`${person} is close to ${vehicle}`)}.`;
    return "I can pass. The gap in front of me is open.";
  }

  function sceneWas() {
    const title = (selected && selected.title) || "This moment";
    const where = placeWords();
    if (!closeCall) return `${title}. I was ${where}. Nothing made me stop.`;
    const person = `a ${closeCall.person}`;
    const vehicle = `a ${closeCall.vehicle}`;
    if (closeCall.call === "Stop") return `${title}. I was ${where}. I stopped. ${cap(`${person} was right against ${vehicle}`)}.`;
    if (closeCall.call === "Wait") return `${title}. I was ${where}. I waited. ${cap(`${person} was close to ${vehicle}`)}.`;
    return `${title}. I was ${where}. I could pass. The gap was open.`;
  }

  function buildMind() {
    const place = sceneLayout.label || "Street";
    const where = placeWords();
    const whoFull = tracks.length ? peakLine(tracks) : "People and vehicles";
    const whoParts = whoFull.split(", ");
    const lead = whoParts.find((part) => /person|people|bicycle/.test(part));
    const vehicles = whoParts.filter((part) => /car|truck|bus|motorcycle/.test(part)).slice(0, 2);
    const who = [lead, ...vehicles].filter(Boolean).slice(0, 2).join(", ") || whoParts.slice(0, 2).join(", ");
    const memory = memoryPrompt();
    const momentTitle = closeCall ? closeCall.call : "Quiet";
    const momentSay = myCall();
    const mid = tracks.length ? tracks[Math.floor(tracks.length / 2)].t || 1 : 1;
    const placeSay = `I'm ${where}.`;
    const whoSay = whoFull === "an empty stretch of road"
      ? "Around me, the road is open."
      : `Around me, ${soften(whoFull)}.`;
    return [
      { id: "place", kicker: "Place", title: place, say: placeSay, t: 0 },
      { id: "who", kicker: "Who", title: soften(who), say: whoSay, t: mid },
      { id: "moment", kicker: "Moment", title: momentTitle, say: momentSay, t: closeCall ? closeCall.t : mid },
      { id: "memory", kicker: "Remember", title: memory.title, say: memory.say, t: closeCall ? closeCall.t : mid },
    ];
  }

  function buildBeats() {
    if (!tracks.length) return [];
    const end = tracks[tracks.length - 1].t || 0;
    const rows = [];
    for (let t = 0; t <= end + 0.01; t += 2.5) {
      let nearest = tracks[0];
      let dist = Math.abs((nearest.t || 0) - t);
      tracks.forEach((frame) => {
        const gap = Math.abs((frame.t || 0) - t);
        if (gap < dist) {
          nearest = frame;
          dist = gap;
        }
      });
      const seen = spokenList(nearest);
      const where = placeWords();
      const open = seen === "an empty stretch of road";
      let text = open
        ? `I'm ${where}. The road in front of me is open.`
        : `I'm ${where}. I see ${soften(seen)}.`;
      let node = "place";
      if (t >= 0.8) {
        text = open ? "Around me, the road is open." : `Around me, ${soften(seen)}.`;
        node = "who";
      }
      if (closeCall && Math.abs(t - closeCall.t) <= 1.25) {
        text = myCall();
        node = "moment";
      }
      rows.push({ t, text, node, said: false });
    }
    return rows;
  }

  function setActiveNode(id) {
    activeNode = id || "";
    document.querySelectorAll(".node").forEach((btn) => {
      const on = btn.id === `node-${activeNode}`;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  function renderMind() {
    const mind = $("mind");
    if (!mind) return;
    mind.innerHTML = "";
    mindNodes.forEach((node) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "node" + (node.id === activeNode ? " active" : "");
      btn.id = `node-${node.id}`;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", node.id === activeNode ? "true" : "false");
      const kicker = document.createElement("span");
      kicker.className = "kicker";
      kicker.textContent = node.kicker;
      const title = document.createElement("span");
      title.className = "node-title";
      title.textContent = node.title;
      btn.append(kicker, title);
      btn.addEventListener("click", () => openNode(node.id));
      mind.appendChild(btn);
    });
  }

  function renderBeatTicks() {
    const scrub = $("scrub");
    const player = $("player");
    if (!scrub) return;
    scrub.querySelectorAll(".beat-tick").forEach((el) => el.remove());
    const duration = player && Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 0;
    beats.forEach((beat, index) => {
      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = "beat-tick";
      tick.setAttribute("aria-label", beat.text);
      const ratio = duration ? Math.min(0.96, Math.max(0.04, beat.t / duration)) : (index + 1) / (beats.length + 1);
      tick.style.left = `${ratio * 100}%`;
      tick.addEventListener("click", () => {
        const playerNow = $("player");
        if (playerNow) {
          playerNow.currentTime = beat.t;
          playerNow.pause();
        }
        showPlayOverlay(false);
        paintDetections(beat.t);
        showLine(beat.text, beat.node, true);
      });
      scrub.appendChild(tick);
    });
  }

  function stopVoice() {
    speakGen += 1;
    if (currentAudio) {
      currentAudio.onended = null;
      currentAudio.pause();
      currentAudio = null;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  function playVoice(text, after) {
    if (!voiceOn || !text) {
      if (after) after();
      return;
    }
    stopVoice();
    const gen = speakGen;
    const done = () => {
      if (gen === speakGen && after) after();
    };
    const url = audioByText.get(text);
    if (url) {
      currentAudio = new Audio(url);
      currentAudio.onended = done;
      currentAudio.play().catch(() => speakBrowser(text, done));
      return;
    }
    if (eleven) {
      fetch(`${BASE}api/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }).then(async (res) => {
        if (gen !== speakGen) return;
        if (!res.ok) {
          speakBrowser(text, done);
          return;
        }
        const blob = await res.blob();
        if (!blob.size || gen !== speakGen) return;
        const fresh = URL.createObjectURL(blob);
        audioByText.set(text, fresh);
        currentAudio = new Audio(fresh);
        currentAudio.onended = done;
        currentAudio.play().catch(() => speakBrowser(text, done));
      }).catch(() => {
        if (gen === speakGen) speakBrowser(text, done);
      });
      return;
    }
    speakBrowser(text, done);
  }

  function speakBrowser(text, after) {
    if (!voiceOn || !window.speechSynthesis) {
      if (after) after();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = 1;
    utterance.onend = () => { if (after) after(); };
    window.speechSynthesis.speak(utterance);
  }

  function showLine(text, nodeId, audible, after) {
    const line = $("spoken");
    if (line && text) line.textContent = text;
    if (nodeId) setActiveNode(nodeId);
    if (audible) playVoice(text, after);
    else if (after) after();
  }

  function openNode(id) {
    const node = mindNodes.find((row) => row.id === id);
    if (!node) return;
    const player = $("player");
    if (player && Number.isFinite(node.t)) {
      if (node.id === "moment") pausedForCall = true;
      try { player.currentTime = node.t; } catch { /* ignore */ }
      player.pause();
      showPlayOverlay(false);
      paintDetections(node.t);
    }
    const follow = node.id === "memory"
      ? () => { if (micReady && voiceOn) startListening(); }
      : null;
    showLine(node.say, node.id, true, follow);
  }

  function saveMemories() {
    try { sessionStorage.setItem("takeaway-memories", JSON.stringify(memories.slice(-12))); } catch { /* ignore */ }
  }

  function currentKey() {
    return (selected && (selected.filename || selected.original_video)) || "";
  }

  function rememberClip() {
    const key = currentKey();
    if (!key || !selected) return;
    const was = sceneWas();
    let row = memories.find((item) => item.key === key);
    if (!row) {
      row = { key, title: selected.title || "Moment", was, notes: [] };
      memories.push(row);
    } else {
      row.title = selected.title || row.title;
      row.was = was;
    }
    if (memories.length > 12) memories.splice(0, memories.length - 12);
    saveMemories();
  }

  function rememberNote(text) {
    const key = currentKey();
    let row = memories.find((item) => item.key === key);
    if (!row) {
      rememberClip();
      row = memories.find((item) => item.key === key);
    }
    if (!row) return;
    row.notes = (row.notes || []).concat(text).slice(-4);
    saveMemories();
  }

  function composeReply(text) {
    const q = text.toLowerCase();
    if (/^(stop|enough|quiet|that is all|that's all|thats all)\b/.test(q)) {
      return { say: "I'll hold that.", listen: false };
    }
    const past = memories.filter((item) => item.key !== currentKey());
    const wantsPast = /before|earlier|previous|last|ago|happened|history|memor|other clip|what did|go through|so far/.test(q);
    if (wantsPast) {
      if (!past.length) {
        const here = memories.find((item) => item.key === currentKey());
        const note = here && here.notes && here.notes.length ? ` You told me, ${here.notes[here.notes.length - 1]}.` : "";
        return { say: `This is the first moment I have with you. ${here ? here.was : ""}${note}`.trim(), listen: true };
      }
      const recent = past.slice(-3);
      const bits = recent.map((item) => {
        const note = item.notes && item.notes.length ? ` You told me, ${item.notes[item.notes.length - 1]}.` : "";
        return `${item.was}${note}`;
      });
      const more = past.length > recent.length ? `I kept ${past.length} earlier moments. The latest are these. ` : "";
      const here = memories.find((item) => item.key === currentKey());
      const now = here ? ` Now, ${here.was}` : "";
      return { say: `${more}Before this, ${bits.join(" Then ")}${now}`.trim(), listen: true };
    }
    return {
      say: `I'll keep that. You said, ${text}. I'm ${placeWords()}. ${myCall()}`,
      listen: true,
    };
  }

  function addTurn(who, text) {
    const list = $("turns");
    if (!list || !text) return;
    const item = document.createElement("li");
    item.className = who;
    item.textContent = text;
    list.appendChild(item);
    while (list.children.length > 6) list.removeChild(list.firstChild);
  }

  function hearUser(text) {
    const said = (text || "").replace(/\s+/g, " ").trim();
    if (!said) return;
    const input = $("askQ");
    if (input) input.value = "";
    addTurn("you", said);
    rememberNote(said);
    const reply = composeReply(said);
    addTurn("me", reply.say);
    showLine(reply.say, "memory", true, () => {
      if (reply.listen && micReady && voiceOn) startListening();
    });
  }

  function syncTalkButton() {
    const btn = $("talkBtn");
    if (!btn) return;
    btn.setAttribute("aria-pressed", listening ? "true" : "false");
    btn.textContent = listening ? "Listening" : "Talk";
  }

  function stopListening() {
    listening = false;
    syncTalkButton();
    if (recorder && recorder.state === "recording") recorder.stop();
  }

  async function startListening() {
    if (listening) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showLine("I can't use the microphone. Type to me instead.", "memory", false);
      const input = $("askQ");
      if (input) input.focus();
      return;
    }
    stopVoice();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micReady = true;
    } catch {
      showLine("I can't use the microphone. Type to me instead.", "memory", false);
      const input = $("askQ");
      if (input) input.focus();
      return;
    }
    recordChunks = [];
    const mime = window.MediaRecorder && MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      showLine("I can't use the microphone. Type to me instead.", "memory", false);
      return;
    }
    listening = true;
    syncTalkButton();
    const line = $("spoken");
    if (line) line.textContent = "I'm listening.";
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) recordChunks.push(event.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      listening = false;
      syncTalkButton();
      const blob = new Blob(recordChunks, { type: recorder.mimeType || "audio/webm" });
      recordChunks = [];
      if (blob.size < 400) return;
      const body = new FormData();
      body.append("audio", blob, "speech.webm");
      try {
        const res = await fetch(`${BASE}api/hear`, { method: "POST", body });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.text) {
          showLine("I missed that. Say it again, or type it.", "memory", true);
          return;
        }
        hearUser(data.text);
      } catch {
        showLine("I missed that. Say it again, or type it.", "memory", false);
      }
    };
    recorder.start();
    window.setTimeout(() => {
      if (listening) stopListening();
    }, 8000);
  }

  function primeMic() {
    if (micReady || micPriming || !navigator.mediaDevices) return;
    micPriming = true;
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      stream.getTracks().forEach((track) => track.stop());
      micReady = true;
      micPriming = false;
    }).catch(() => {
      micReady = false;
      micPriming = false;
    });
  }

  function moveMind(step) {
    if (!mindNodes.length) return;
    const ids = mindNodes.map((node) => node.id);
    let index = ids.indexOf(activeNode);
    if (index < 0) index = 0;
    index = Math.max(0, Math.min(ids.length - 1, index + step));
    openNode(ids[index]);
    const btn = document.getElementById(`node-${ids[index]}`);
    if (btn) btn.focus();
  }

  async function preloadSpeech(lines) {
    const token = ++preloadToken;
    if (!eleven) return;
    const unique = [...new Set(lines.filter(Boolean))];
    for (const text of unique) {
      if (token !== preloadToken) return;
      if (audioByText.has(text)) continue;
      try {
        const res = await fetch(`${BASE}api/speak`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          eleven = false;
          return;
        }
        const blob = await res.blob();
        if (!blob.size) continue;
        audioByText.set(text, URL.createObjectURL(blob));
      } catch {
        eleven = false;
        return;
      }
    }
  }

  function refreshMind() {
    mindNodes = buildMind();
    beats = buildBeats();
    if (!activeNode) activeNode = "place";
    renderMind();
    renderBeatTicks();
    const place = mindNodes.find((node) => node.id === "place");
    const line = $("spoken");
    if (line && place && !line.dataset.held) line.textContent = place.say;
    preloadSpeech([
      ...mindNodes.map((node) => node.say),
      ...beats.map((beat) => beat.text),
    ]);
    rememberClip();
  }

  function speakDueBeat(time) {
    const beat = beats.find((row) => !row.said && time + 0.05 >= row.t && time < row.t + 0.55);
    if (!beat) return;
    beat.said = true;
    showLine(beat.text, beat.node, true);
  }

  function syncVoiceButton() {
    const btn = $("voiceBtn");
    if (!btn) return;
    btn.setAttribute("aria-pressed", voiceOn ? "true" : "false");
    btn.textContent = voiceOn ? "Voice on" : "Voice off";
  }

  function renderCams() {
    const wrap = $("cams");
    if (!wrap) return;
    const group = selected && selected.group;
    const related = group ? samples.filter((item) => item.group === group) : [];
    wrap.hidden = related.length < 2;
    wrap.innerHTML = "";
    related.forEach((item) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cam" + (selected && selected.original_video === item.original_video ? " active" : "");
      b.textContent = item.theme || item.title;
      b.addEventListener("click", () => selectSample(item));
      wrap.appendChild(b);
    });
  }

  function renderMenu() {
    const panel = $("menuPanel");
    if (!panel) return;
    panel.innerHTML = "";
    samples.forEach((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "menu-item" + (selected && selected.original_video === s.original_video ? " selected" : "");
      b.setAttribute("role", "option");
      b.innerHTML = `<div class="menu-item-title"></div><div class="menu-item-meta"></div>`;
      b.querySelector(".menu-item-title").textContent = s.title;
      b.querySelector(".menu-item-meta").textContent = s.theme || "";
      b.addEventListener("click", () => {
        selectSample(s);
        setMenuOpen(false);
      });
      panel.appendChild(b);
    });
  }

  async function loadSignals(s) {
    const box = $("signals");
    if (!box) return;
    box.innerHTML = "";
    if (!s.preview_source) return;
    try {
      const data = await api(`api/signals?source=${encodeURIComponent(s.preview_source)}`);
      (data.objects || []).forEach((obj) => {
        const el = document.createElement("span");
        el.className = "chip";
        el.textContent = `${obj.label} ${obj.count}`;
        box.appendChild(el);
      });
    } catch {
      /* chips are optional */
    }
  }

  async function selectSample(s) {
    selected = s;
    renderMenu();
    $("clipTitle").textContent = s.title || "Lesson";
    const theme = $("clipTheme");
    if (theme) theme.textContent = s.theme || "";
    sceneLayout = readLayout(s.scene, []);
    closeCall = null;
    pausedForCall = false;
    tracks = [];
    const mark = $("closeMark");
    if (mark) mark.hidden = true;
    paintGuide(s);
    renderCams();
    activeNode = "place";
    beats = [];
    const spoken = $("spoken");
    if (spoken) {
      delete spoken.dataset.held;
      spoken.textContent = "Press play. I'll tell you what I see, as me.";
    }
    stopListening();
    stopVoice();
    refreshMind();
    loadSignals(s);

    const player = $("player");
    const source = playbackSource(s);
    if (!player || !source) return;
    loadTracks(source);
    if (player.dataset.source !== source) {
      player.dataset.source = source;
      player.src = proxyUrl(source);
      player.load();
    }
    showPlayOverlay(true);
    const reveal = () => {
      try { player.currentTime = Math.min(0.35, (player.duration || 1) * 0.05); } catch { /* ignore */ }
    };
    if (player.readyState >= 1) reveal();
    else player.addEventListener("loadedmetadata", reveal, { once: true });
    player.onplay = () => showPlayOverlay(false);
    player.onpause = () => { if (player.currentTime < 0.2) showPlayOverlay(true); };
    player.onended = () => showPlayOverlay(true);
    player.ontimeupdate = () => {
      paintDetections(player.currentTime);
      if (
        closeCall &&
        !pausedForCall &&
        !player.paused &&
        Math.abs(player.currentTime - closeCall.t) < 0.4
      ) {
        pausedForCall = true;
        player.pause();
        showCloseCall(closeCall);
        const moment = mindNodes.find((node) => node.id === "moment");
        const memory = mindNodes.find((node) => node.id === "memory");
        const line = [moment && moment.say, memory && memory.say].filter(Boolean).join(" ");
        if (line) {
          showLine(line, "memory", true, () => {
            if (micReady && voiceOn) startListening();
          });
        }
        return;
      }
      if (!player.paused) speakDueBeat(player.currentTime);
    };
    player.onseeked = () => {
      paintDetections(player.currentTime);
      beats.forEach((beat) => {
        if (beat.t > player.currentTime + 0.2) beat.said = false;
      });
    };
    player.onloadedmetadata = () => renderBeatTicks();
    player.onloadeddata = () => paintDetections(player.currentTime);
  }

  async function playSelected() {
    const player = $("player");
    if (!player || !player.src) return;
    primeMic();
    try {
      await player.play();
      showPlayOverlay(false);
      speakDueBeat(player.currentTime || 0);
    } catch {
      showPlayOverlay(true);
    }
  }

  function runAsk(e) {
    if (e) e.preventDefault();
    const input = $("askQ");
    const question = ((input && input.value) || "").trim();
    if (!question) return;
    hearUser(question);
  }

  async function loadScenario(next) {
    scenario = next;
    document.querySelectorAll(".scenario").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.scenario === scenario);
    });
    const data = await api(`api/samples?scenario=${encodeURIComponent(scenario)}`);
    starter = (data.scenario && data.scenario.starter) || starter;
    const q = $("askQ");
    if (q) {
      q.placeholder = "Tell me, or ask what happened before";
      q.value = "";
    }
    samples = data.samples || [];
    if (samples[0]) selectSample(samples[0]);
    else {
      $("clipTitle").textContent = "No lesson found";
      $("look").textContent = "";
      $("move").textContent = "";
      $("avoid").textContent = "";
    }
  }

  const menuBtn = $("menuBtn");
  if (menuBtn) {
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setMenuOpen(!menuOpen);
    });
  }
  document.addEventListener("click", (e) => {
    if (!menuOpen) return;
    const wrap = document.querySelector(".menu-wrap");
    if (wrap && !wrap.contains(e.target)) setMenuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setMenuOpen(false);
  });
  document.querySelectorAll(".scenario").forEach((btn) => {
    btn.addEventListener("click", () => loadScenario(btn.dataset.scenario));
  });
  const closeMark = $("closeMark");
  if (closeMark) {
    closeMark.addEventListener("click", () => {
      jumpToCloseCall();
      const moment = mindNodes.find((node) => node.id === "moment");
      const memory = mindNodes.find((node) => node.id === "memory");
      const line = [moment && moment.say, memory && memory.say].filter(Boolean).join(" ");
      if (line) {
        showLine(line, "memory", true, () => {
          if (micReady && voiceOn) startListening();
        });
      }
    });
  }
  syncVoiceButton();
  syncTalkButton();
  const talkBtn = $("talkBtn");
  if (talkBtn) {
    talkBtn.addEventListener("click", () => {
      if (listening) stopListening();
      else startListening();
    });
  }
  const voiceBtn = $("voiceBtn");
  if (voiceBtn) {
    voiceBtn.addEventListener("click", () => {
      voiceOn = !voiceOn;
      try { localStorage.setItem("takeaway-voice", voiceOn ? "1" : "0"); } catch { /* ignore */ }
      syncVoiceButton();
      if (!voiceOn) stopVoice();
    });
  }
  const mind = $("mind");
  if (mind) {
    mind.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        moveMind(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveMind(-1);
      }
    });
  }
  api("api/voice").then((data) => {
    eleven = !!data.eleven;
    if (mindNodes.length) {
      preloadSpeech([
        ...mindNodes.map((node) => node.say),
        ...beats.map((beat) => beat.text),
      ]);
    }
  }).catch(() => { eleven = false; });
  const playOverlay = $("playOverlay");
  if (playOverlay) playOverlay.addEventListener("click", playSelected);
  const askForm = $("askForm");
  if (askForm) askForm.addEventListener("submit", runAsk);

  loadScenario("bike").catch((err) => {
    $("clipTitle").textContent = err.message;
  });
})();
