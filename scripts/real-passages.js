/**
 * Real Passages
 * Interactive, DM-authorized passages (stairs, elevators, chutes, portals) for
 * Foundry VTT (dnd5e).
 *
 * A passage is a clickable marker (an Actor + Token, like Real Chests) placed on
 * the map and linked to a partner marker somewhere else — on the same scene or a
 * different one. A player double-clicks the marker and presses "Use Passage".
 * Depending on configuration the passage either moves them immediately, or asks
 * the DM to approve, then auto-rolls a skill check vs a DC. On success the
 * player's token is moved to the linked destination (and, across scenes, the
 * player is pulled to the target scene). On failure a configured trap deals
 * damage, and the player may optionally be allowed through anyway.
 *
 * DMs can Lock (temporarily block), Collapse (permanently block), or Reopen a
 * passage after it has been used (e.g. an elevator that can't be recalled), and
 * can grant specific players Free Traversal so they move back and forth at will.
 */

const MODULE_ID = "real-passages";
const SOCKET = `module.${MODULE_ID}`;

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/** Read (and default) a passage's configuration from its flags. */
function getConfig(actor) {
  const f = actor?.getFlag(MODULE_ID, "config") ?? {};
  return {
    label: f.label ?? actor?.name ?? "Passage",
    linkUuid: f.linkUuid ?? "",
    skill: f.skill ?? "",
    dc: Number(f.dc ?? 10),
    requireApproval: f.requireApproval ?? true,
    trapFormula: f.trapFormula ?? "",
    trapType: f.trapType ?? "none",
    passOnFail: f.passOnFail ?? false,
    note: f.note ?? "",
    connectionId: f.connectionId ?? "",
    state: f.state ?? "open",
    freeTravelers: Array.isArray(f.freeTravelers) ? f.freeTravelers : []
  };
}

function isPassage(actor) {
  return actor?.getFlag(MODULE_ID, "isPassage") === true;
}

/** The character a user is playing, or their first owned character. */
function userCharacter(user = game.user) {
  if (user.character) return user.character;
  return game.actors.find(a => a.type === "character" && a.testUserPermission(user, "OWNER")) ?? null;
}

/** Re-render any open sheets for the given passage on this client. */
function rerenderPassage(passageId) {
  const actor = game.actors.get(passageId);
  if (!actor) return;
  for (const app of Object.values(actor.apps ?? {})) app.render(false);
}

/** Human label for a skill key. */
function skillLabel(key) {
  return key ? (CONFIG.DND5E?.skills?.[key]?.label ?? key) : null;
}

/** Apply trap damage to an actor across dnd5e version signatures. */
async function applyTrapDamage(actor, amount, type) {
  if (!actor || !amount) return;
  try {
    return await actor.applyDamage([{ value: amount, type: type && type !== "none" ? type : "" }]);
  } catch (e) {
    try {
      return await actor.applyDamage(amount, 1);
    } catch (e2) {
      const hp = actor.system?.attributes?.hp;
      if (hp) await actor.update({ "system.attributes.hp.value": Math.max(0, (hp.value ?? 0) - amount) });
    }
  }
}

/**
 * Resolve a passage's link target into a destination scene + coordinates.
 * The link points at a partner passage's Token (by uuid); the traveller lands
 * on that token's square.
 * @returns {Promise<{scene: Scene, x: number, y: number}|null>}
 */
async function resolveLink(linkUuid) {
  if (!linkUuid) return null;
  let doc;
  try { doc = await fromUuid(linkUuid); } catch (e) { return null; }
  if (!doc) return null;
  // The linked document is a TokenDocument embedded in a Scene.
  const scene = doc.parent instanceof foundry.documents.BaseScene || doc.parent?.documentName === "Scene"
    ? doc.parent
    : game.scenes.get(doc.parent?.id);
  if (!scene) return null;
  return { scene, x: doc.x, y: doc.y };
}

/** Find a character's token document on a given scene. */
function findActorToken(scene, actorId) {
  if (!scene) return null;
  return scene.tokens.find(t => t.actorId === actorId) ?? null;
}

/* -------------------------------------------- */
/*  Socket handling                             */
/* -------------------------------------------- */

function emit(payload) {
  game.socket.emit(SOCKET, payload);
}

/**
 * Broadcast a semantic Real Passages event as a Foundry hook so other modules
 * (e.g. an AI flavor-text module) can react, and dispatch to Connection Manager
 * if a connection is configured.
 */
function fireEvent(name, ctx = {}) {
  const payload = { module: MODULE_ID, event: name, ...ctx };
  Hooks.callAll(`${MODULE_ID}.${name}`, payload);
  emit({ type: "event", name, ctx: payload });
  if (ctx.connectionId) {
    game.modules.get("connection-manager")?.api?.run?.(ctx.connectionId, payload);
  }
}

/** Build the shared event context for a passage action. */
function passageEventCtx(passage, pc, extra = {}) {
  const cfg = getConfig(passage);
  return {
    kind: "passage",
    passage: cfg.label ?? passage?.name ?? "a passage",
    passageId: passage?.id ?? null,
    character: pc?.name ?? "Someone",
    actorId: pc?.id ?? null,
    skill: skillLabel(cfg.skill),
    dc: cfg.dc ?? null,
    note: cfg.note ?? null,
    scene: canvas.scene?.name ?? null,
    sceneId: canvas.scene?.id ?? null,
    connectionId: cfg.connectionId || null,
    ...extra
  };
}

async function onSocket(data) {
  switch (data?.type) {
    case "attempt": return handleAttemptAsGM(data);
    case "decision": return handleDecisionAsPlayer(data);
    case "traverse": return handleTraverseAsGM(data);
    case "refresh": return rerenderPassage(data.passageId);
    case "event": return void Hooks.callAll(`${MODULE_ID}.${data.name}`, data.ctx);
  }
}

/* -------------------------------------------- */
/*  Player use flow                             */
/* -------------------------------------------- */

/** Base payload identifying a traversal request. */
function traversalBase(passage, pc) {
  const scene = canvas.scene;
  const token = canvas.tokens?.controlled?.find(t => t.actor?.id === pc.id)?.document
    ?? findActorToken(scene, pc.id);
  return {
    passageId: passage.id,
    userId: game.user.id,
    actorId: pc.id,
    sourceSceneId: scene?.id ?? null,
    tokenId: token?.id ?? null
  };
}

/**
 * Player side: roll the configured skill check (if any) and, on success or an
 * allowed pass-through, ask the GM to move the token. Fires semantic events.
 */
async function attemptCheckAndTraverse(passage, pc, base, forced) {
  const cfg = getConfig(passage);
  const name = cfg.label || passage.name;

  // No check needed (forced by DM, or no skill configured) -> traverse.
  if (forced || !cfg.skill) {
    emit({ type: "traverse", ...base, success: true });
    fireEvent("traversed", passageEventCtx(passage, pc, {
      success: true, forced: !!forced,
      action: forced ? "waved through by the DM" : "passed through"
    }));
    return;
  }

  if (!pc) {
    ui.notifications.error("You have no assigned character to make the check.");
    return;
  }

  const mod = pc.system?.skills?.[cfg.skill]?.total ?? 0;
  const roll = await new Roll("1d20 + @mod", { mod }).evaluate();
  const label = skillLabel(cfg.skill);
  const success = roll.total >= cfg.dc;
  await roll.toMessage({
    speaker: { actor: pc?.id, alias: pc?.name },
    flavor: `${label} check to use ${name} (DC ${cfg.dc}) &mdash; ${success ? "<strong>Success!</strong>" : "<strong>Failed</strong>"}`
  });

  if (success) {
    emit({ type: "traverse", ...base, success: true });
    fireEvent("traversed", passageEventCtx(passage, pc, {
      success: true, roll: roll.total,
      action: `crossed after a successful ${label} check`
    }));
    return;
  }

  // Failure -> spring the trap, if any.
  let trapDamage = null, trapType = null;
  if (cfg.trapFormula) {
    const trap = await new Roll(cfg.trapFormula).evaluate();
    trapDamage = trap.total;
    trapType = cfg.trapType;
    await trap.toMessage({
      speaker: { actor: pc?.id, alias: pc?.name },
      flavor: `${name} was trapped! ${cfg.trapType !== "none" ? cfg.trapType + " " : ""}damage`
    });
    await applyTrapDamage(pc, trap.total, cfg.trapType);
  }

  if (cfg.passOnFail) {
    ui.notifications.info(`You stumble through ${name} anyway.`);
    emit({ type: "traverse", ...base, success: false });
    fireEvent("traversed", passageEventCtx(passage, pc, {
      success: false, passthrough: true, roll: roll.total,
      trapped: !!cfg.trapFormula, trapDamage, trapType,
      action: `forced through despite failing the ${label} check`
    }));
  } else {
    ui.notifications.info(`You fail to use ${name}.`);
    fireEvent("failed", passageEventCtx(passage, pc, {
      success: false, roll: roll.total, trapped: !!cfg.trapFormula,
      trapDamage, trapType, action: `failed the ${label} check`
    }));
  }
}

/** GM side: a player requested to use a passage -> show approval dialog. */
async function handleAttemptAsGM(data) {
  if (game.users.activeGM?.id !== game.user.id) return;
  const passage = game.actors.get(data.passageId);
  const requester = game.users.get(data.userId);
  const pc = game.actors.get(data.actorId);
  if (!passage || !requester) return;

  const cfg = getConfig(passage);
  const name = cfg.label || passage.name;
  const link = await resolveLink(cfg.linkUuid);
  const dest = link ? link.scene.name : "an unlinked destination";
  const label = skillLabel(cfg.skill);
  const checkLine = cfg.skill
    ? `<p><strong>Requires:</strong> ${label} check vs DC ${cfg.dc}${cfg.trapFormula ? ` &mdash; trapped (${cfg.trapFormula} ${cfg.trapType})` : ""}${cfg.passOnFail ? " &mdash; passes through even on failure" : ""}</p>`
    : `<p><em>No skill check configured (will cross on approval).</em></p>`;

  const content = `
    <div class="rp-approval">
      <p><strong>${requester.name}</strong>${pc ? ` (${pc.name})` : ""} wants to use <strong>${name}</strong> &rarr; <em>${dest}</em>.</p>
      ${checkLine}
      ${cfg.note ? `<fieldset><legend>DM Note</legend>${foundry.utils.escapeHTML?.(cfg.note) ?? cfg.note}</fieldset>` : ""}
      <label class="rp-force"><input type="checkbox" name="force" /> Force through (skip the check &mdash; crosses immediately)</label>
    </div>`;

  const { DialogV2 } = foundry.applications.api;
  const decision = await DialogV2.wait({
    window: { title: `Passage Request: ${name}` },
    content,
    buttons: [
      {
        action: "approve", label: "Approve", icon: "fas fa-check", default: true,
        callback: (event, button) => button.form.elements.force.checked ? "force" : "approve"
      },
      { action: "deny", label: "Deny", icon: "fas fa-ban", callback: () => "deny" }
    ],
    rejectClose: false
  }).catch(() => "deny") ?? "deny";

  emit({
    type: "decision",
    passageId: data.passageId,
    userId: data.userId,
    actorId: data.actorId,
    sourceSceneId: data.sourceSceneId,
    tokenId: data.tokenId,
    approved: decision !== "deny",
    force: decision === "force"
  });
}

/** Player side: the GM responded to our request. */
async function handleDecisionAsPlayer(data) {
  if (data.userId !== game.user.id) return;
  const passage = game.actors.get(data.passageId);
  const pc = game.actors.get(data.actorId);
  if (!passage) return;

  if (!data.approved) {
    ui.notifications.warn(`The DM denied your attempt to use ${getConfig(passage).label || passage.name}.`);
    return;
  }
  const base = {
    passageId: data.passageId, userId: data.userId, actorId: data.actorId,
    sourceSceneId: data.sourceSceneId, tokenId: data.tokenId
  };
  await attemptCheckAndTraverse(passage, pc, base, !!data.force);
}

/* -------------------------------------------- */
/*  GM traversal (the actual token move)        */
/* -------------------------------------------- */

/** GM side: move the requesting player's token to the linked destination. */
async function handleTraverseAsGM(data) {
  if (game.users.activeGM?.id !== game.user.id) return;
  const passage = game.actors.get(data.passageId);
  const user = game.users.get(data.userId);
  const pc = game.actors.get(data.actorId);
  if (!passage || !user || !pc) return;

  const cfg = getConfig(passage);
  if (cfg.state === "collapsed" || cfg.state === "locked") return; // safety re-check

  const link = await resolveLink(cfg.linkUuid);
  if (!link) {
    ChatMessage.create({
      whisper: [user.id, ...ChatMessage.getWhisperRecipients("GM").map(u => u.id)],
      content: `<em>${cfg.label || passage.name} has no linked destination configured.</em>`
    });
    return;
  }

  const sourceScene = game.scenes.get(data.sourceSceneId);
  const crossScene = link.scene.id !== sourceScene?.id;
  const destX = link.x;
  const destY = link.y;

  if (!crossScene) {
    // Same scene: just move the existing token.
    const tok = (data.tokenId ? sourceScene?.tokens.get(data.tokenId) : null)
      ?? findActorToken(sourceScene, pc.id);
    if (tok) await tok.update({ x: destX, y: destY });
    else ui.notifications.warn(`${pc.name} has no token on this scene to move.`);
  } else {
    // Cross scene: place/move the character's token on the target scene...
    let destTok = findActorToken(link.scene, pc.id);
    if (destTok) {
      await destTok.update({ x: destX, y: destY });
    } else {
      const tdata = (await pc.getTokenDocument({ x: destX, y: destY })).toObject();
      await link.scene.createEmbeddedDocuments("Token", [tdata]);
    }
    // ...remove the source token so the character truly leaves the origin...
    const srcTok = (data.tokenId ? sourceScene?.tokens.get(data.tokenId) : null)
      ?? findActorToken(sourceScene, pc.id);
    if (srcTok) await srcTok.delete();
    // ...and pull the owning player to the destination scene.
    if (user.active) link.scene.pullUsers([user.id]);
  }
}

/* -------------------------------------------- */
/*  GM state controls                           */
/* -------------------------------------------- */

/** GM-only writer for a passage's state (open / locked / collapsed). */
async function setState(passage, state) {
  if (!game.user.isGM) return;
  const cfg = getConfig(passage);
  await passage.setFlag(MODULE_ID, "config", { ...cfg, state });
  emit({ type: "refresh", passageId: passage.id });
  rerenderPassage(passage.id);
  fireEvent(state === "open" ? "reopened" : state, passageEventCtx(passage, userCharacter(), {
    action: state === "open" ? "reopened by the DM"
      : state === "locked" ? "locked by the DM"
        : "collapsed by the DM"
  }));
}

/* -------------------------------------------- */
/*  Custom passage sheet                        */
/* -------------------------------------------- */

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

class RealPassageSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["real-passages", "rp-sheet"],
    position: { width: 480, height: "auto" },
    window: { icon: "fa-solid fa-stairs", resizable: true },
    actions: {
      rpUse: RealPassageSheet.#onUse,
      rpDelete: RealPassageSheet.#onDelete,
      rpLock: RealPassageSheet.#onLock,
      rpUnlock: RealPassageSheet.#onUnlock,
      rpCollapse: RealPassageSheet.#onCollapse
    },
    form: { handler: RealPassageSheet.#onSubmitConfig, submitOnChange: false, closeOnSubmit: false }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/passage-sheet.hbs` }
  };

  get title() {
    return getConfig(this.actor)?.label ?? this.actor?.name ?? "Passage";
  }

  async _prepareContext(options) {
    const actor = this.actor;
    const cfg = getConfig(actor);
    const isGM = game.user.isGM;
    const free = cfg.freeTravelers.includes(game.user.id);

    const skills = [{ key: "", label: "— None —", selected: !cfg.skill }].concat(
      Object.entries(CONFIG.DND5E?.skills ?? {})
        .map(([key, v]) => ({ key, label: v.label, selected: key === cfg.skill }))
        .sort((a, b) => a.label.localeCompare(b.label))
    );

    const damageTypes = [{ key: "none", label: "— None —" }].concat(
      Object.entries(CONFIG.DND5E?.damageTypes ?? {}).map(([key, v]) => ({ key, label: (v?.label ?? key) }))
    ).map(d => ({ ...d, selected: d.key === cfg.trapType }));

    // Every other passage's token, on any scene, as a link candidate.
    const passages = [{ uuid: "", name: "— None —", selected: !cfg.linkUuid }];
    for (const sc of game.scenes) {
      for (const t of sc.tokens) {
        if (t.actor && isPassage(t.actor) && t.actor.id !== actor.id) {
          const plabel = getConfig(t.actor).label || t.name;
          passages.push({ uuid: t.uuid, name: `${plabel} — ${sc.name}`, selected: t.uuid === cfg.linkUuid });
        }
      }
    }
    let linkName = null;
    if (cfg.linkUuid) {
      const link = await resolveLink(cfg.linkUuid).catch(() => null);
      linkName = link ? link.scene.name : "(missing)";
    }

    const players = game.users.filter(u => !u.isGM).map(u => ({
      id: u.id, name: u.name, checked: cfg.freeTravelers.includes(u.id)
    }));

    const cmApi = game.modules.get("connection-manager")?.api;
    const connections = [{ id: "", name: "— None —", selected: !cfg.connectionId }].concat(
      (cmApi?.getConnections?.() ?? []).map(c => ({ id: c.id, name: c.name, selected: c.id === cfg.connectionId }))
    );

    return {
      actor, cfg, isGM, free, skills, damageTypes, passages, players, connections, linkName,
      linked: !!cfg.linkUuid,
      stateOpen: cfg.state === "open",
      stateLocked: cfg.state === "locked",
      stateCollapsed: cfg.state === "collapsed",
      canUse: cfg.state === "open"
    };
  }

  /**
   * The framework disables every form control on non-editable sheets (players
   * only have LIMITED ownership). Keep the interactive "Use" button enabled.
   */
  _toggleDisabled(disabled) {
    super._toggleDisabled(disabled);
    if (!game.user.isGM) {
      for (const btn of this.element.querySelectorAll('button[data-action="rpUse"]')) {
        btn.disabled = false;
        btn.removeAttribute("disabled");
      }
    }
  }

  /* --- Action handlers (this === sheet instance) --- */

  static async #onUse(event, target) {
    const pc = userCharacter();
    if (!pc) {
      ui.notifications.error("You have no assigned character. Ask your DM to assign one.");
      return;
    }
    const passage = this.actor;
    const cfg = getConfig(passage);
    const name = cfg.label || passage.name;

    if (cfg.state === "collapsed") { ui.notifications.warn(`${name} has collapsed and cannot be used.`); return; }
    if (cfg.state === "locked") { ui.notifications.warn(`${name} is locked.`); return; }

    const base = traversalBase(passage, pc);
    if (!base.sourceSceneId) { ui.notifications.error("You must be viewing the scene to use a passage."); return; }

    const free = cfg.freeTravelers.includes(game.user.id);

    // Free traversal, or an open passage with no gating -> cross immediately.
    if (free || (!cfg.skill && !cfg.requireApproval)) {
      emit({ type: "traverse", ...base, success: true });
      fireEvent("traversed", passageEventCtx(passage, pc, {
        success: true, action: free ? "traversed freely" : "passed through"
      }));
      ui.notifications.info(`Traveling through ${name}...`);
      return;
    }

    // Requires DM approval first.
    if (cfg.requireApproval) {
      emit({ type: "attempt", ...base });
      ui.notifications.info(`Requested to use ${name}. Waiting for the DM...`);
      return;
    }

    // Skill check, no approval needed -> roll right away.
    await attemptCheckAndTraverse(passage, pc, base, false);
  }

  static async #onDelete(event, target) {
    const proceed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Passage" },
      content: `<p>Delete <strong>${getConfig(this.actor).label || this.actor.name}</strong> and its marker token(s)?</p>`
    }).catch(() => false);
    if (!proceed) return;
    // Remove tokens across scenes, then the actor.
    for (const sc of game.scenes) {
      const ids = sc.tokens.filter(t => t.actorId === this.actor.id).map(t => t.id);
      if (ids.length) await sc.deleteEmbeddedDocuments("Token", ids);
    }
    await this.actor.delete();
  }

  static async #onLock(event, target) { await setState(this.actor, "locked"); this.render(false); }
  static async #onUnlock(event, target) { await setState(this.actor, "open"); this.render(false); }
  static async #onCollapse(event, target) { await setState(this.actor, "collapsed"); this.render(false); }

  static async #onSubmitConfig(event, form, formData) {
    const d = formData.object;
    const cfg = getConfig(this.actor);
    const freeTravelers = game.users
      .filter(u => !u.isGM && d[`free-${u.id}`])
      .map(u => u.id);

    const linkUuid = d.linkUuid ?? "";
    await this.actor.setFlag(MODULE_ID, "config", {
      ...cfg,
      label: (d.label ?? "").trim() || this.actor.name,
      linkUuid,
      skill: d.skill ?? "",
      dc: Number(d.dc ?? 10),
      requireApproval: !!d.requireApproval,
      trapFormula: (d.trapFormula ?? "").trim(),
      trapType: d.trapType ?? "none",
      passOnFail: !!d.passOnFail,
      note: d.note ?? "",
      connectionId: d.connectionId ?? "",
      state: d.state ?? "open",
      freeTravelers
    });

    // Optionally mirror the link on the partner passage for two-way travel.
    if (d.bidirectional && linkUuid) {
      const partnerTok = await fromUuid(linkUuid).catch(() => null);
      const partner = partnerTok?.actor;
      const myTok = this.#firstToken();
      if (partner && myTok && isPassage(partner)) {
        const pcfg = getConfig(partner);
        await partner.setFlag(MODULE_ID, "config", { ...pcfg, linkUuid: myTok.uuid });
        emit({ type: "refresh", passageId: partner.id });
      }
    }

    ui.notifications.info(`${getConfig(this.actor).label} configuration saved.`);
    this.render(false);
  }

  /** Find this passage's first token document across all scenes. */
  #firstToken() {
    for (const sc of game.scenes) {
      const t = sc.tokens.find(t => t.actorId === this.actor.id);
      if (t) return t;
    }
    return null;
  }
}

/* -------------------------------------------- */
/*  Passage creation                            */
/* -------------------------------------------- */

async function createPassage({ name = "Passage", img = "icons/svg/stairs.svg", drop = true } = {}) {
  const LIMITED = CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED;
  const actor = await Actor.create({
    name,
    type: "npc",
    img,
    ownership: { default: LIMITED },
    prototypeToken: {
      name,
      texture: { src: img },
      actorLink: false,
      disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
      sight: { enabled: false }
    },
    flags: {
      [MODULE_ID]: {
        isPassage: true,
        config: {
          label: name, linkUuid: "", skill: "", dc: 10, requireApproval: true,
          trapFormula: "", trapType: "none", passOnFail: false, note: "",
          connectionId: "", state: "open", freeTravelers: []
        }
      },
      core: { sheetClass: `${MODULE_ID}.RealPassageSheet` }
    }
  });

  if (drop && canvas?.ready && canvas.scene) {
    const d = canvas.dimensions;
    const x = Math.round((d?.sceneX ?? 0) + (d?.sceneWidth ?? 2000) / 2);
    const y = Math.round((d?.sceneY ?? 0) + (d?.sceneHeight ?? 2000) / 2);
    const tokenData = (await actor.getTokenDocument({ x, y })).toObject();
    await canvas.scene.createEmbeddedDocuments("Token", [tokenData]);
  }

  actor.sheet.render(true);
  return actor;
}

/* -------------------------------------------- */
/*  Hooks                                        */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const DSC = foundry.applications.apps?.DocumentSheetConfig ?? globalThis.DocumentSheetConfig;
  DSC.registerSheet(Actor, MODULE_ID, RealPassageSheet, {
    types: ["npc"],
    makeDefault: false,
    label: "Real Passage"
  });
  console.log(`${MODULE_ID} | initialised`);
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocket);
  const mod = game.modules.get(MODULE_ID);
  mod.api = { createPassage, getConfig, isPassage, setState, resolveLink, RealPassageSheet };
  console.log(`${MODULE_ID} | ready. Create a passage with: game.modules.get('${MODULE_ID}').api.createPassage()`);
});

// GM tool to create a passage marker from the Token scene controls.
Hooks.on("getSceneControlButtons", controls => {
  if (!game.user.isGM) return;
  const tool = {
    name: "create-passage",
    title: "Create Real Passage",
    icon: "fa-solid fa-stairs",
    button: true,
    order: 98,
    onChange: () => createPassage()
  };
  if (Array.isArray(controls)) {
    const tokens = controls.find(c => c.name === "token" || c.name === "tokens");
    tokens?.tools?.push(tool);
  } else {
    const tokens = controls.tokens ?? controls.token;
    if (tokens?.tools) tokens.tools["create-passage"] = tool;
  }
});
