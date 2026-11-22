// SimPhy keeps selections and open panels local. World coordinates, bodies,
// constraints and playback belong to the board object.
function createSharedSimulation() {
  const token = () => Array.from(crypto.getRandomValues(new Uint32Array(3)), n => n.toString(36)).join('-');
  const client = token();
  const bodyFields = ['id', 'm', 'mu', 'size', 'shape', 'is_static', 'x', 'y', 'vx', 'vy',
    'ax', 'ay', 'rest_idx', 'restitution', 'color', 'locked_F_ext', 'preview_F_ext', 'liveForce',
    'rope_force_x', 'rope_force_y', 'forces_values', 'forces_vectors'];
  const ropeFields = ['id', 'is_elastic', 'max_length', 'segments', 'tension_force'];
  const springFields = ['id', 'k', 'rest_length', 'damping', 'segments', 'tension_force'];
  const groups = [['bodies', bodyFields], ['ropes', ropeFields], ['springs', springFields]];
  const copy = value => JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let epoch = token(), port, record, baseline, inFlight, failed = false;
  let pending = [], activeForce = null, dirty = true;
  let offset = 0, nextAttempt = 0, lastSend = 0;
  let authoritative, displayedAt, history;
  const physics = new PhysicsSimulation();
  const nowStep = () => Math.floor((Date.now() + offset) / (FIXED_DT * 1000));
  const checkpointInterval = 300;
  const takeoverDelay = 30 + Math.floor(Math.random() * 30);
  let strokes = [], pen = false, line = null;
  let pointer = null, strokeId = '', lastStrokeSent = 0;
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    const p = sim.camera.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    return [Number(p.x.toFixed(3)), Number(p.y.toFixed(3))];
  };
  canvas.addEventListener('pointerdown', event => {
    if (!pen || !event.isPrimary || event.button !== 0) return;
    event.stopImmediatePropagation();
    pointer = event.pointerId;
    strokeId = token();
    lastStrokeSent = 0;
    line = [point(event)];
    canvas.setPointerCapture(pointer);
  }, true);
  for (const name of ['pointermove', 'pointerup', 'pointercancel']) {
    canvas.addEventListener(name, event => {
      if (!line || pointer !== event.pointerId) return;
      event.stopImmediatePropagation();
      if (name !== 'pointercancel') line.push(point(event));
      if (name === 'pointermove' && performance.now() - lastStrokeSent >= 90) {
        port.postMessage({ type: 'stroke', id: strokeId, points: line });
        lastStrokeSent = performance.now();
      }
      if (name !== 'pointermove') {
        if (name === 'pointerup') {
          strokes.push({ points: line });
          port.postMessage({ type: 'stroke', id: strokeId, points: line });
        }
        line = null;
        pointer = null;
      }
    }, true);
  }
  function drawInk() {
    if (!line && !strokes.length) return;
    ctx.save();
    ctx.strokeStyle = '#ffe36a';
    ctx.lineWidth = 3;
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const stroke of line ? [...strokes, { points: line }] : strokes) {
      ctx.beginPath();
      stroke.points.forEach(([x, y], i) => {
        const p = sim.camera.worldToScreen(x, y);
        if (!i) ctx.moveTo(p.x - 0.1, p.y);
        ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }
    ctx.restore();
  }
  document.body.inert = true;

  function capture(world, meta) {
    const entities = {};
    for (const [group, fields] of groups) {
      for (const entity of world[group]) {
        entity.roomKey ||= token();
        const data = { group };
        for (const field of fields) {
          if (entity[field] !== undefined) data[field] = entity[field];
        }
        if (group !== 'bodies') {
          data.a = entity.body_a.roomKey;
          data.b = entity.body_b.roomKey;
        }
        entities[entity.roomKey] = data;
      }
    }
    return copy({ epoch: meta.epoch, meta: { alpha: world.alpha, paused: world.paused,
      scenario: world.currentScenario, initialP: world.initial_p, initialEk: world.initial_Ek,
      speed: meta.speed, zoom: meta.zoom ?? PPM }, entities });
  }

  function restore(world, scene) {
    const byKey = new Map(world.getAllEntities().map(e => [e.roomKey, e]));
    const alive = new Map();
    for (const [group, fields] of groups) {
      world[group] = [];
      for (const [key, data] of Object.entries(scene.entities)) {
        if (data.group !== group) continue;
        let e = byKey.get(key);
        if (group !== 'bodies' && (!alive.has(data.a) || !alive.has(data.b))) continue;
        if (!e) {
          if (group === 'bodies') e = new PhysicsBody(data.id, data.m, data.mu, data.x);
          else if (group === 'ropes') e = new RopeConstraint(data.id, alive.get(data.a), alive.get(data.b), data.max_length, data.is_elastic);
          else e = new SpringConstraint(data.id, alive.get(data.a), alive.get(data.b), data.k, data.rest_length);
        }
        for (const field of fields) {
          if (data[field] !== undefined) e[field] = data[field];
        }
        e.roomKey = key;
        world[group].push(e);
        alive.set(key, e);
        world.entity_counter = Math.max(world.entity_counter, Number(e.id) || 0);
      }
    }
    world.alpha = scene.meta.alpha;
    world.currentScenario = scene.meta.scenario;
    world.initial_p = scene.meta.initialP;
    world.initial_Ek = scene.meta.initialEk;
    world.paused = scene.meta.paused;
    return alive;
  }

  function changedFields(before, after) {
    return Object.fromEntries(Object.entries(after).filter(([key, value]) => !equal(before[key], value)));
  }

  function changes(before, after) {
    if (before.epoch !== after.epoch) return { replace: after };
    const meta = changedFields(before.meta, after.meta);
    const add = {}, edit = {};
    const remove = Object.keys(before.entities).filter(key => !after.entities[key]);
    for (const [key, entity] of Object.entries(after.entities)) {
      if (!before.entities[key]) add[key] = entity;
      else {
        const fields = changedFields(before.entities[key], entity);
        if (Object.keys(fields).length) edit[key] = fields;
      }
    }
    if (Object.keys(meta).length || Object.keys(add).length || Object.keys(edit).length || remove.length) {
      return { epoch: after.epoch, meta, add, edit, remove };
    }
  }

  // Reapply only the edited fields when another participant wins a revision.
  // A deleted body cannot be resurrected by a delayed drag or link edit.
  function apply(scene, op) {
    if (op.replace) return copy(op.replace);
    if (scene.epoch !== op.epoch) return scene;
    if (op.steps) {
      const world = new PhysicsSimulation();
      restore(world, scene);
      for (let i = 0; i < op.steps; i++) {
        world.step_frame = true;
        world.step(FIXED_DT * scene.meta.speed);
      }
      return capture(world, { epoch: scene.epoch, speed: scene.meta.speed, zoom: scene.meta.zoom });
    }
    Object.assign(scene.meta, op.meta);
    for (const [key, added] of Object.entries(op.add)) {
      const entity = copy(added);
      const existing = Object.values(scene.entities);
      if (existing.some(other => other.group === entity.group && other.id === entity.id)) {
        entity.id = existing.reduce((max, other) => Math.max(max, other.id), 0) + 1;
      }
      scene.entities[key] = entity;
    }
    for (const [key, fields] of Object.entries(op.edit)) {
      if (scene.entities[key]) Object.assign(scene.entities[key], copy(fields));
    }
    for (const key of op.remove) delete scene.entities[key];
    for (const [key, ent] of Object.entries(scene.entities)) {
      if (ent.group !== 'bodies' && (!scene.entities[ent.a] || !scene.entities[ent.b])) delete scene.entities[key];
    }
    return scene;
  }

  function collect() {
    if (!baseline || !dirty) return;
    dirty = false;
    if (activeForce && (!sim.setting_force || activeForce !== sim.selected_entity)) {
      activeForce.liveForce = false;
      activeForce = null;
    }
    if (sim.setting_force && sim.selected_entity instanceof PhysicsBody) {
      activeForce = sim.selected_entity;
      activeForce.liveForce = true;
    }
    const next = capture(sim, { epoch, speed: speedMultiplier });
    const op = changes(baseline, next);
    if (op) pending.push(op);
    if (sim.step_frame) {
      pending.push({ epoch, steps: 1 });
      sim.step_frame = false;
    }
    baseline = next;
  }

  function display(scene) {
    const replaced = epoch !== scene.epoch;
    epoch = scene.epoch;
    const alive = restore(sim, copy(scene));
    for (const ent of sim.selected_entities) {
      if (!alive.has(ent.roomKey)) sim.selected_entities.delete(ent);
    }
    if (!alive.has(sim.selected_entity?.roomKey)) {
      sim.selected_entity = replaced ? sim.bodies[0] : [...sim.selected_entities][0];
      if (sim.selected_entity) sim.selected_entities.add(sim.selected_entity);
    }
    if (draggedBody && !alive.has(draggedBody.roomKey)) {
      draggedBody = null;
      dragBodyOffsets.clear();
    }
    if (sim.linking_first && !alive.has(sim.linking_first.roomKey)) cancelLinking();
    if (activeForce && !alive.has(activeForce.roomKey)) {
      sim.setting_force = false;
      activeForce = null;
      document.getElementById('forcePullBanner').style.display = 'none';
      document.getElementById('pillForce').classList.remove('force-active');
    }
    speedMultiplier = scene.meta.speed;
    PPM = scene.meta.zoom ?? 45;
    const speed = document.getElementById('speedSelect');
    for (const option of speed.options) option.selected = Number(option.value) === speedMultiplier;
    const play = document.getElementById('btnPlay');
    play.textContent = sim.paused ? '▶ СТАРТ' : '⏸ ПАУЗА';
    play.classList.toggle('paused', sim.paused);
    const scenario = document.getElementById('btnScenDropdown');
    for (const btn of document.querySelectorAll('.scenario-btn[data-scen]')) {
      const selected = btn.dataset.scen === sim.currentScenario;
      btn.classList.toggle('active', selected);
      if (selected) scenario.textContent = btn.textContent.trim() + ' ▼';
    }
    baseline = scene;
  }

  function advance(world, speed, steps) {
    if (world.paused) return;
    for (let i = 0; i < steps; i++) world.step(FIXED_DT * speed);
  }

  function replay(start, entries) {
    let { scene, at } = start;
    scene = copy(scene);
    for (const entry of entries) {
      if (!scene.meta.paused && entry.at > at) {
        restore(physics, scene);
        // After a long period with nobody connected, resume from the saved
        // experiment without trying to calculate hours of unattended motion.
        advance(physics, scene.meta.speed, Math.min(entry.at - at, 420));
        scene = capture(physics, { epoch: scene.epoch, speed: scene.meta.speed, zoom: scene.meta.zoom });
      }
      for (const op of entry.ops) scene = apply(scene, op);
      at = entry.at;
    }
    return { scene, at };
  }

  function send(at, commands, scene) {
    inFlight = { count: pending.length };
    lastSend = performance.now();
    port.postMessage({ type: 'commit', base: record?.revision || 0, at, client, commands,
      scene: scene && JSON.stringify(scene) });
  }

  function frame() {
    if (!record || failed) return;
    const now = performance.now();
    if (keysDown.KeyW || keysDown.KeyS) dirty = true;
    collect();
    const target = Math.max(displayedAt, nowStep());
    if (target > displayedAt) {
      // Spread catch-up over multiple repaints after a background tab resumes.
      const steps = sim.paused ? target - displayedAt : Math.min(target - displayedAt, 30);
      advance(sim, speedMultiplier, steps);
      displayedAt += steps;
      if (!sim.paused) baseline = capture(sim, { epoch, speed: speedMultiplier });
    }
    if (inFlight || now < nextAttempt || now - lastSend < 75) return;
    const age = target - record.at;
    const active = !authoritative.scene.meta.paused;
    const due = active && age >= checkpointInterval + (record.owner === client ? 0 : takeoverDelay);
    if (!pending.length && !due) return;
    const at = Math.max(target, authoritative.at);
    const ops = pending.slice();
    const commands = [{ at, ops }];
    const transition = ops.some(op => op.replace || Object.hasOwn(op.meta || {}, 'paused'));
    const snapshot = due || transition || history.length >= 32
      ? replay(authoritative, commands).scene : undefined;
    send(at, commands, snapshot);
  }

  function receive({ data }) {
    if (data.type === 'clock') { offset = data.offset; return; }
    if (data.type === 'ink') { strokes = data.strokes; return; }
    if (data.type === 'pen') {
      pen = data.enabled;
      canvas.style.cursor = pen ? 'crosshair' : '';
      return;
    }
    if (failed) return;
    collect();
    if (data.type === 'error') {
      failed = true;
      document.body.inert = true;
      return;
    }
    if (data.type === 'ack') {
      if (!inFlight) return;
      if (data.ok) pending.splice(0, inFlight.count);
      else nextAttempt = performance.now() + 15 + Math.random() * 40;
      inFlight = null;
    }
    if (data.record && data.scene && (!record || data.record.revision > record.revision)) {
      const entries = JSON.parse(data.record.commands);
      const sameCheckpoint = record?.checkpoint === data.record.checkpoint;
      const start = sameCheckpoint ? authoritative : { scene: JSON.parse(data.scene), at: data.record.at };
      authoritative = replay(start, sameCheckpoint ? entries.slice(history.length) : entries);
      history = entries;
      record = data.record;
    }
    if (!record) {
      if (!inFlight) {
        const scene = data.scene ? JSON.parse(data.scene) : capture(sim, { epoch, speed: speedMultiplier });
        scene.meta.zoom ??= 45;
        send(nowStep(), [], scene);
      }
      return;
    }
    // The value event for our transaction may precede its acknowledgement.
    // Apply the outstanding intent once, after the acknowledgement arrives.
    if (inFlight) return;
    const at = Math.max(authoritative.at, nowStep());
    let state = replay(authoritative, [{ at, ops: [] }]);
    state = replay(state, [{ at, ops: pending }]);
    display(state.scene);
    displayedAt = state.at;
    if (document.body.inert) {
      document.body.inert = false;
      port.postMessage({ type: 'ready' });
    }
    frame();
  }

  window.addEventListener('message', event => {
    if (port || event.source !== parent || event.data !== 'simphy-connect' || !event.ports[0]) return;
    if (event.origin !== location.origin) return;
    port = event.ports[0];
    port.onmessage = receive;
    // Browsers may suspend canvas animation when a board panel covers the iframe.
    window.setInterval(frame, 75);
  });
  for (const event of ['click', 'input', 'change', 'wheel', 'pointerdown', 'pointerup', 'pointermove', 'keydown', 'keyup']) {
    window.addEventListener(event, () => { dirty = true; }, true);
  }
  return { frame, drawInk, newScene() { epoch = token(); dirty = true; } };
}
