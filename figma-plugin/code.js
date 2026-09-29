// SPDX-License-Identifier: GPL-3.0-or-later
// figma-plugin/code.js — RoLink Bridge Figma plugin (sandbox).
//
// Polling lives in ui.html (the UI iframe has reliable fetch to localhost;
// the sandbox fetch surface varies between Desktop and web). This file only
// executes Figma API calls forwarded from the UI via figma.ui.onmessage and
// replies with JSON-safe results. It never touches the network and never
// throws out (every handler returns {ok, result|error}).
//
// Protocol (UI <-> code):
//   UI -> code: {type: "execute", id, tool, args}
//   code -> UI: {type: "result", id, result} | {type: "result", id, error}
//
// FIGMA_PLUGIN_VERSION is reported as ?pv= with every poll so the bridge can
// track it in figma_status. Keep in sync with the release zip.
var FIGMA_PLUGIN_VERSION = "1.1.0";

// ── JSON-safe helpers ────────────────────────────────────────────────

function safeStr(v, max) {
  try {
    var s = (v === null || v === undefined) ? "" : String(v);
    return s.slice(0, max || 400);
  } catch (e) {
    return "";
  }
}

function colorToRgb(fill) {
  try {
    var c = fill.color || { r: 0, g: 0, b: 0 };
    return { r: +c.r || 0, g: +c.g || 0, b: +c.b || 0, a: (fill.opacity !== undefined ? +fill.opacity : 1) };
  } catch (e) {
    return { r: 0, g: 0, b: 0, a: 1 };
  }
}

function nodeSummary(node, depth) {
  // Shallow, JSON-safe snapshot. Children are ids only past depth 1 so a huge
  // document never blows the 10MB /queue/result body cap.
  var out = {
    id: node.id,
    name: safeStr(node.name, 120),
    type: node.type,
  };
  try {
    if (node.absoluteBoundingBox) {
      var b = node.absoluteBoundingBox;
      out.bounds = { x: +b.x || 0, y: +b.y || 0, width: +b.width || 0, height: +b.height || 0 };
    }
  } catch (e) { /* bounds optional */ }
  try {
    if (node.fills && node.fills !== figma.mixed) {
      out.fills = (node.fills || []).slice(0, 4).map(function (f) {
        return { type: f.type, visible: f.visible !== false, color: f.color ? colorToRgb(f) : undefined };
      });
    }
  } catch (e) { /* fills optional */ }
  try {
    if (typeof node.cornerRadius === "number") out.cornerRadius = +node.cornerRadius || 0;
  } catch (e) {}
  try {
    if (node.layoutMode && node.layoutMode !== "NONE") {
      out.layoutMode = node.layoutMode;
      out.itemSpacing = +node.itemSpacing || 0;
    }
  } catch (e) {}
  try {
    if (node.type === "TEXT") {
      out.characters = safeStr(node.characters, 2000);
      out.fontSize = (typeof node.fontSize === "number") ? +node.fontSize : undefined;
    }
  } catch (e) {}
  if (depth > 0 && node.children) {
    try {
      out.children = node.children.slice(0, 50).map(function (ch) { return nodeSummary(ch, depth - 1); });
      out.childCount = node.children.length;
    } catch (e) {
      out.children = [];
    }
  } else if (node.children) {
    try {
      out.childIds = node.children.slice(0, 100).map(function (ch) { return ch.id; });
      out.childCount = node.children.length;
    } catch (e) {}
  }
  return out;
}

function applyFills(node, fills) {
  if (!fills) return;
  if (fills === "none" || fills === null) {
    node.fills = [];
    return;
  }
  var list = Array.isArray(fills) ? fills : [fills];
  node.fills = list.slice(0, 8).map(function (f) {
    if (typeof f === "string") {
      // "#rrggbb" shorthand.
      var m = /^#?([0-9a-f]{6})$/i.exec(f);
      var r = 1, g = 1, b = 1;
      if (m) {
        r = parseInt(m[1].slice(0, 2), 16) / 255;
        g = parseInt(m[1].slice(2, 4), 16) / 255;
        b = parseInt(m[1].slice(4, 6), 16) / 255;
      }
      return { type: "SOLID", color: { r: r, g: g, b: b } };
    }
    var c = (f && f.color) || {};
    return {
      type: "SOLID",
      visible: f.visible !== false,
      opacity: (f.opacity !== undefined ? +f.opacity : (c.a !== undefined ? +c.a : 1)),
      color: { r: +c.r || 0, g: +c.g || 0, b: +c.b || 0 },
    };
  });
}

// ── Tool handlers ────────────────────────────────────────────────────

function handleCreateFrame(args) {
  var title = safeStr((args && (args.title || args.name)) || "RoLink Frame", 120) || "RoLink Frame";
  var width = Math.max(1, Math.min(4000, parseInt((args && (args.width || args.w)) || 400, 10) || 400));
  var height = Math.max(1, Math.min(4000, parseInt((args && (args.height || args.h)) || 600, 10) || 600));
  var frame = figma.createFrame();
  frame.name = title;
  frame.resize(width, height);
  // Place next to the current viewport centre so it is visible immediately.
  try {
    var cx = 0, cy = 0;
    if (figma.viewport && figma.viewport.center) { cx = figma.viewport.center.x; cy = figma.viewport.center.y; }
    frame.x = Math.round(cx - width / 2);
    frame.y = Math.round(cy - height / 2);
  } catch (e) {}
  try {
    figma.currentPage.appendChild(frame);
    figma.currentPage.selection = [frame];
    try { figma.viewport.scrollAndZoomIntoView([frame]); } catch (e) {}
  } catch (e) {}
  return { id: frame.id, name: frame.name, width: width, height: height };
}

function applyCommonProps(node, args) {
  // Shared styler for handleSetProperties + handleCreateNode. Returns true
  // when at least one property was applied.
  var applied = false;
  if ("name" in args) { node.name = safeStr(args.name, 120); applied = true; }
  if ("fills" in args) { applyFills(node, args.fills); applied = true; }
  if ("opacity" in args && typeof node.opacity === "number") {
    node.opacity = Math.max(0, Math.min(1, +args.opacity));
    applied = true;
  }
  if ("cornerRadius" in args && typeof node.cornerRadius === "number") {
    node.cornerRadius = Math.max(0, Math.min(500, +args.cornerRadius || 0));
    applied = true;
  }
  if ("layoutMode" in args && "layoutMode" in node) {
    var m = String(args.layoutMode || "NONE").toUpperCase();
    node.layoutMode = (m === "VERTICAL" || m === "HORIZONTAL") ? m : "NONE";
    if (args.itemSpacing !== undefined && "itemSpacing" in node) {
      node.itemSpacing = Math.max(0, +args.itemSpacing || 0);
    }
    applied = true;
  }
  return applied;
}

function handleGetNodes(args) {
  var nodeId = args && (args.nodeId || args.id);
  var summarize = function (list, depth) {
    return list.slice(0, 10).map(function (n) { return nodeSummary(n, depth); });
  };
  if (nodeId) {
    // dynamic-page documentAccess forbids the sync getNodeById — the async
    // variant is the only legal lookup.
    return figma.getNodeByIdAsync(String(nodeId)).then(function (n) {
      if (!n) throw new Error("figma_get_nodes: no node with id " + safeStr(nodeId, 80));
      var nodes = [nodeSummary(n, 2)];
      return { count: nodes.length, nodes: nodes };
    });
  }
  var nodes;
  if (figma.currentPage.selection && figma.currentPage.selection.length) {
    nodes = summarize(figma.currentPage.selection, 2);
  } else {
    nodes = [nodeSummary(figma.currentPage, 1)];
  }
  return Promise.resolve({ count: nodes.length, nodes: nodes });
}

function handleSetProperties(args) {
  var nodeId = args && (args.nodeId || args.id);
  if (!nodeId) return Promise.reject(new Error("figma_set_properties: 'nodeId' is required"));
  return figma.getNodeByIdAsync(String(nodeId)).then(function (node) {
    if (!node) throw new Error("figma_set_properties: no node with id " + safeStr(nodeId, 80));
    var had = ("fills" in args) || ("strokes" in args) || ("cornerRadius" in args) ||
      ("layoutMode" in args) || ("name" in args) || ("opacity" in args);
    if (!had) {
      throw new Error("figma_set_properties: nothing to set (pass fills, strokes, cornerRadius, layoutMode, name, or opacity)");
    }
    applyCommonProps(node, args);
    return { id: node.id, name: safeStr(node.name, 120), updated: true };
  });
}

function handleCreateNode(args) {
  var parentId = args && (args.parentId || args.parent || args.nodeId);
  if (!parentId) {
    return Promise.reject(new Error("figma_create_node: 'parentId' is required (a frame id from figma_create_frame)"));
  }
  var type = String((args && args.type) || "RECTANGLE").toUpperCase();
  if (type !== "TEXT" && type !== "RECTANGLE" && type !== "ELLIPSE" && type !== "FRAME") {
    return Promise.reject(new Error("figma_create_node: type must be TEXT|RECTANGLE|ELLIPSE|FRAME, got " + safeStr(type, 40)));
  }
  return figma.getNodeByIdAsync(String(parentId)).then(function (parent) {
    if (!parent) throw new Error("figma_create_node: no parent with id " + safeStr(parentId, 80));
    if (typeof parent.appendChild !== "function") {
      throw new Error("figma_create_node: parent type " + parent.type + " cannot hold children - use a FRAME id");
    }
    var make = function () {
      var node;
      if (type === "TEXT") node = figma.createText();
      else if (type === "ELLIPSE") node = figma.createEllipse();
      else if (type === "FRAME") node = figma.createFrame();
      else node = figma.createRectangle();
      node.name = safeStr((args && args.name) || type.charAt(0) + type.slice(1).toLowerCase(), 120);
      var b = (args && args.bounds) || {};
      var w = Math.max(1, Math.min(4000, Math.round(+b.width || +((args && args.width)) || 200)));
      var h = Math.max(1, Math.min(4000, Math.round(+b.height || +((args && args.height)) || 100)));
      if (typeof node.resize === "function") {
        try { node.resize(w, h); } catch (e) {}
      }
      node.x = Math.round(+b.x || 0);
      node.y = Math.round(+b.y || 0);
      applyCommonProps(node, args || {});
      parent.appendChild(node);
      return { id: node.id, name: safeStr(node.name, 120), type: type, parentId: parent.id };
    };
    if (type !== "TEXT") return make();
    // TEXT nodes refuse characters until a font is loaded. The node is
    // detached until appended below, so probing its default font is safe.
    var node = figma.createText();
    var candidates = [{ family: "Inter", style: "Regular" }];
    try {
      var def = node.fontName;
      if (def && def.family && (def.family !== "Inter" || def.style !== "Regular")) {
        candidates.push({ family: def.family, style: def.style });
      }
    } catch (e) {}
    var chain = Promise.reject(new Error("fonts"));
    candidates.forEach(function (f) {
      chain = chain.catch(function () { return figma.loadFontAsync(f); });
    });
    return chain.then(function () {
      node.name = safeStr((args && args.name) || "Text", 120);
      node.characters = safeStr((args && args.characters) || "Text", 500);
      try {
        node.fontSize = Math.max(6, Math.min(400, Math.round(+((args && args.fontSize)) || 14)));
      } catch (e) {}
      var b = (args && args.bounds) || {};
      node.x = Math.round(+b.x || 0);
      node.y = Math.round(+b.y || 0);
      try {
        var w = Math.max(1, Math.min(4000, Math.round(+b.width || 200)));
        node.resize(w, Math.max(1, Math.round(+b.height || 60)));
      } catch (e) {}
      applyCommonProps(node, args || {});
      parent.appendChild(node);
      return { id: node.id, name: safeStr(node.name, 120), type: type, parentId: parent.id };
    });
  });
}

// ── Shared async lookup (dynamic-page bans sync getNodeById) ──────────

function lookupNode(args, field) {
  var id = args && (args[field || "nodeId"] || args.id);
  if (!id) return Promise.reject(new Error("figma: '" + (field || "nodeId") + "' is required"));
  return figma.getNodeByIdAsync(String(id)).then(function (n) {
    if (!n) throw new Error("figma: no node with id " + safeStr(id, 80));
    return n;
  });
}

function lookupNodes(ids) {
  if (!Array.isArray(ids) || !ids.length) {
    return Promise.reject(new Error("figma: 'nodeIds' must be a non-empty array of ids"));
  }
  if (ids.length > 50) {
    return Promise.reject(new Error("figma: max 50 nodes per call, got " + ids.length));
  }
  var chain = Promise.resolve([]);
  ids.forEach(function (raw) {
    chain = chain.then(function (out) {
      return figma.getNodeByIdAsync(String(raw)).then(function (n) {
        if (!n) throw new Error("figma: no node with id " + safeStr(raw, 80));
        out.push(n);
        return out;
      });
    });
  });
  return chain;
}

function absBox(node) {
  try {
    var b = node.absoluteBoundingBox;
    if (b) return { x: +b.x || 0, y: +b.y || 0, width: +b.width || 0, height: +b.height || 0 };
  } catch (e) {}
  return { x: 0, y: 0, width: 0, height: 0 };
}

function parentOrigin(node) {
  // x/y are parent-relative; absoluteBoundingBox is absolute. Subtract the
  // parent origin to convert. Pages have no box — origin 0,0.
  try {
    var p = node.parent;
    if (p && p.absoluteBoundingBox) {
      return { x: +p.absoluteBoundingBox.x || 0, y: +p.absoluteBoundingBox.y || 0 };
    }
  } catch (e) {}
  return { x: 0, y: 0 };
}

function placeAbsolute(node, ax, ay) {
  var o = parentOrigin(node);
  node.x = Math.round(ax - o.x);
  node.y = Math.round(ay - o.y);
}

function solidColor(input, fallback) {
  var fb = fallback || { r: 1, g: 1, b: 1 };
  if (typeof input === "string") {
    var m = /^#?([0-9a-f]{6})$/i.exec(input);
    if (m) {
      return { r: parseInt(m[1].slice(0, 2), 16) / 255,
               g: parseInt(m[1].slice(2, 4), 16) / 255,
               b: parseInt(m[1].slice(4, 6), 16) / 255 };
    }
    return fb;
  }
  var c = (input && input.color) || input || {};
  return { r: +(c.r || fb.r) || 0, g: +(c.g || fb.g) || 0, b: +(c.b || fb.b) || 0 };
}

function b64ToBytes(b64) {
  // Manual base64 decode — the sandbox may lack atob.
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  var clean = String(b64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
  var out = [];
  var i = 0;
  while (i < clean.length) {
    var e1 = chars.indexOf(clean.charAt(i++));
    var e2 = chars.indexOf(clean.charAt(i++));
    var e3 = chars.indexOf(clean.charAt(i++));
    var e4 = chars.indexOf(clean.charAt(i++));
    if (e1 < 0 || e2 < 0) break;
    var n = (e1 << 18) | (e2 << 12) | ((e3 & 63) << 6) | (e4 & 63);
    out.push((n >> 16) & 255);
    if (e3 !== 64 && e3 >= 0) out.push((n >> 8) & 255);
    if (e4 !== 64 && e4 >= 0) out.push(n & 255);
  }
  return out;
}

// ── CRUD: delete / duplicate / move / resize ─────────────────────────

function handleDeleteNode(args) {
  return lookupNode(args).then(function (node) {
    var id = node.id, name = safeStr(node.name, 120);
    node.remove();
    return { id: id, name: name, deleted: true };
  });
}

function handleDuplicateNode(args) {
  return lookupNode(args).then(function (node) {
    var copy = node.clone();
    try {
      var holder = node.parent || figma.currentPage;
      holder.appendChild(copy);
    } catch (e) {}
    try { copy.x = (copy.x || 0) + 16; copy.y = (copy.y || 0) + 16; } catch (e) {}
    try { copy.name = safeStr(node.name, 100) + " copy"; } catch (e) {}
    return { id: copy.id, name: safeStr(copy.name, 120), sourceId: node.id, duplicated: true };
  });
}

function handleMoveNode(args) {
  return lookupNode(args).then(function (node) {
    var destId = args && (args.newParentId || args.parentId || args.parent);
    var target = node.parent;
    var chained = Promise.resolve(target);
    if (destId) {
      chained = figma.getNodeByIdAsync(String(destId)).then(function (p) {
        if (!p) throw new Error("figma_move_node: no parent with id " + safeStr(destId, 80));
        if (typeof p.appendChild !== "function") {
          throw new Error("figma_move_node: parent type " + p.type + " cannot hold children");
        }
        return p;
      });
    }
    return chained.then(function (holder) {
      if (args && args.index !== undefined && typeof holder.insertChild === "function") {
        var idx = Math.max(0, Math.min(holder.children.length, parseInt(args.index, 10) || 0));
        holder.insertChild(idx, node);
      } else {
        holder.appendChild(node);
      }
      if (args && (args.x !== undefined || args.y !== undefined)) {
        var b = absBox(node);
        var o = parentOrigin(node);
        if (args.x !== undefined) node.x = Math.round(+args.x - o.x);
        else node.x = Math.round(b.x - o.x);
        if (args.y !== undefined) node.y = Math.round(+args.y - o.y);
        else node.y = Math.round(b.y - o.y);
      }
      return { id: node.id, name: safeStr(node.name, 120),
               parentId: holder.id, moved: true };
    });
  });
}

function handleResizeNode(args) {
  return lookupNode(args).then(function (node) {
    var w = args && (args.width !== undefined ? +args.width : undefined);
    var h = args && (args.height !== undefined ? +args.height : undefined);
    if ((w === undefined || isNaN(w)) && (h === undefined || isNaN(h))) {
      throw new Error("figma_resize_node: pass width and/or height");
    }
    var b = absBox(node);
    w = (w === undefined || isNaN(w)) ? Math.round(b.width) : Math.max(1, Math.min(4000, Math.round(w)));
    h = (h === undefined || isNaN(h)) ? Math.round(b.height) : Math.max(1, Math.min(4000, Math.round(h)));
    try {
      if (typeof node.resize === "function") node.resize(w, h);
      else throw new Error("node type " + node.type + " cannot resize");
    } catch (e) {
      throw new Error("figma_resize_node failed (" + node.type + "): " +
        String((e && e.message) || e).slice(0, 160));
    }
    return { id: node.id, width: w, height: h, resized: true };
  });
}

// ── Text ─────────────────────────────────────────────────────────────

function withLoadedFont(node, fn) {
  // Run fn() with a usable font. Existing document fonts usually work as-is;
  // on failure, load Inter then the node's own default and retry once.
  try {
    var r = fn();
    return (r && typeof r.then === "function") ? r : Promise.resolve(r);
  } catch (e) {
    var first = String((e && e.message) || e);
    if (!/font/i.test(first)) return Promise.reject(e);
    var candidates = [{ family: "Inter", style: "Regular" }];
    try {
      var def = node.fontName;
      if (def && def.family) candidates.push({ family: def.family, style: def.style || "Regular" });
    } catch (e2) {}
    var chain = Promise.reject(e);
    candidates.forEach(function (f) {
      chain = chain.catch(function () { return figma.loadFontAsync(f); });
    });
    return chain.then(fn);
  }
}

function handleSetText(args) {
  if (!args || args.characters === undefined) {
    return Promise.reject(new Error("figma_set_text: 'characters' is required"));
  }
  return lookupNode(args).then(function (node) {
    if (node.type !== "TEXT") {
      throw new Error("figma_set_text: node type " + node.type + " is not TEXT");
    }
    var text = safeStr(args.characters, 2000);
    return withLoadedFont(node, function () {
      node.characters = text;
      return { id: node.id, characters: text, updated: true };
    });
  });
}

function handleSetFont(args) {
  return lookupNode(args).then(function (node) {
    if (node.type !== "TEXT") {
      throw new Error("figma_set_font: node type " + node.type + " is not TEXT");
    }
    if (args.family === undefined && args.size === undefined && args.style === undefined) {
      throw new Error("figma_set_font: pass family and/or style and/or size");
    }
    var apply = function () {
      if (args.family !== undefined || args.style !== undefined) {
        var cur = { family: "Inter", style: "Regular" };
        try {
          var fn = node.fontName;
          if (fn && fn.family) cur = { family: fn.family, style: fn.style || "Regular" };
        } catch (e) {}
        node.fontName = {
          family: safeStr(args.family !== undefined ? args.family : cur.family, 80) || cur.family,
          style: safeStr(args.style !== undefined ? args.style : cur.style, 40) || cur.style,
        };
      }
      if (args.size !== undefined) {
        node.fontSize = Math.max(6, Math.min(400, Math.round(+args.size || 14)));
      }
      return { id: node.id, updated: true };
    };
    if (args.family !== undefined || args.style !== undefined) {
      var want = {
        family: safeStr(args.family !== undefined ? args.family : "Inter", 80) || "Inter",
        style: safeStr(args.style !== undefined ? args.style : "Regular", 40) || "Regular",
      };
      return figma.loadFontAsync(want).then(apply, function () {
        return withLoadedFont(node, apply);
      });
    }
    return withLoadedFont(node, apply);
  });
}

// ── Style: stroke / shadow / blur / constraint / visibility ───────────

function handleSetStroke(args) {
  return lookupNode(args).then(function (node) {
    if (args.weight === undefined && args.fills === undefined && args.color === undefined) {
      throw new Error("figma_set_stroke: pass weight and/or fills and/or color (#rrggbb)");
    }
    if (args.weight !== undefined && "strokeWeight" in node) {
      node.strokeWeight = Math.max(0, Math.min(100, +args.weight || 0));
    }
    var paint = args.fills !== undefined ? args.fills : args.color;
    if (paint !== undefined && "strokes" in node) {
      var list = Array.isArray(paint) ? paint : [paint];
      node.strokes = list.slice(0, 8).map(function (f) {
        return { type: "SOLID", color: solidColor(f), opacity: 1 };
      });
      if (node.strokeWeight === 0 && "strokeWeight" in node) node.strokeWeight = 1;
    }
    return { id: node.id, updated: true };
  });
}

function handleSetShadow(args) {
  return lookupNode(args).then(function (node) {
    if (!("effects" in node)) {
      throw new Error("figma_set_shadow: node type " + node.type + " has no effects");
    }
    if (args.remove === true || args.enabled === false) {
      node.effects = (node.effects || []).filter(function (e) {
        return e.type !== "DROP_SHADOW" && e.type !== "INNER_SHADOW";
      });
      return { id: node.id, removed: true };
    }
    var off = args.offset || {};
    node.effects = [{
      type: args.inner === true ? "INNER_SHADOW" : "DROP_SHADOW",
      color: { r: 0, g: 0, b: 0, a: Math.max(0, Math.min(1, +(args.opacity !== undefined ? args.opacity : 0.25))) },
      offset: { x: +(off.x || 0), y: +(off.y || (args.inner === true ? 0 : 4)) },
      radius: Math.max(0, Math.min(200, +(args.radius !== undefined ? args.radius : 8))),
      spread: Math.max(0, Math.min(100, +(args.spread || 0))),
      visible: true,
      blendMode: "NORMAL",
    }];
    return { id: node.id, updated: true };
  });
}

function handleSetBlur(args) {
  return lookupNode(args).then(function (node) {
    if (!("effects" in node)) {
      throw new Error("figma_set_blur: node type " + node.type + " has no effects");
    }
    if (args.remove === true || +(args.radius || 0) <= 0) {
      node.effects = (node.effects || []).filter(function (e) {
        return e.type !== "LAYER_BLUR" && e.type !== "BACKGROUND_BLUR";
      });
      return { id: node.id, removed: true };
    }
    var bg = String(args.mode || "background").toLowerCase() !== "layer";
    node.effects = [{
      type: bg ? "BACKGROUND_BLUR" : "LAYER_BLUR",
      radius: Math.max(1, Math.min(200, +args.radius || 12)),
      visible: true,
    }];
    return { id: node.id, updated: true };
  });
}

function handleSetConstraint(args) {
  var H = ["MIN", "CENTER", "MAX", "STRETCH", "SCALE"];
  var V = ["MIN", "CENTER", "MAX", "STRETCH", "SCALE"];
  return lookupNode(args).then(function (node) {
    if (!("constraints" in node)) {
      throw new Error("figma_set_constraint: node type " + node.type + " has no constraints");
    }
    var cur = node.constraints || { horizontal: "MIN", vertical: "MIN" };
    var h = args.horizontal !== undefined ? String(args.horizontal).toUpperCase() : cur.horizontal;
    var v = args.vertical !== undefined ? String(args.vertical).toUpperCase() : cur.vertical;
    if (H.indexOf(h) < 0) throw new Error("figma_set_constraint: horizontal must be " + H.join("|"));
    if (V.indexOf(v) < 0) throw new Error("figma_set_constraint: vertical must be " + V.join("|"));
    node.constraints = { horizontal: h, vertical: v };
    return { id: node.id, constraints: node.constraints, updated: true };
  });
}

function handleSetVisible(args) {
  return lookupNode(args).then(function (node) {
    if (args.visible === undefined) {
      throw new Error("figma_set_visible: 'visible' (true|false) is required");
    }
    node.visible = !!args.visible;
    return { id: node.id, visible: node.visible, updated: true };
  });
}

function handleSetLocked(args) {
  return lookupNode(args).then(function (node) {
    if (args.locked === undefined) {
      throw new Error("figma_set_locked: 'locked' (true|false) is required");
    }
    node.locked = !!args.locked;
    return { id: node.id, locked: node.locked, updated: true };
  });
}

function handleSetClips(args) {
  return lookupNode(args).then(function (node) {
    if (!("clipsContent" in node)) {
      throw new Error("figma_set_clips: node type " + node.type + " cannot clip");
    }
    if (args.clips === undefined) {
      throw new Error("figma_set_clips: 'clips' (true|false) is required");
    }
    node.clipsContent = !!args.clips;
    return { id: node.id, clips: node.clipsContent, updated: true };
  });
}

function handleSetMinMax(args) {
  var keys = ["minWidth", "minHeight", "maxWidth", "maxHeight"];
  return lookupNode(args).then(function (node) {
    var any = false;
    keys.forEach(function (k) {
      if (args[k] !== undefined && k in node) {
        node[k] = args[k] === null ? null : Math.max(0, +args[k] || 0);
        any = true;
      }
    });
    if (!any) {
      throw new Error("figma_set_min_max: pass minWidth/minHeight/maxWidth/maxHeight (null clears)");
    }
    return { id: node.id, updated: true };
  });
}

// ── Layout: auto-layout, axis, sizing ─────────────────────────────────

function handleSetAutoLayout(args) {
  return lookupNode(args).then(function (node) {
    if (!("layoutMode" in node)) {
      throw new Error("figma_set_auto_layout: node type " + node.type + " has no auto-layout (FRAME only)");
    }
    var m = String(args.mode !== undefined ? args.mode : args.layoutMode || "VERTICAL").toUpperCase();
    if (["VERTICAL", "HORIZONTAL", "NONE"].indexOf(m) < 0) {
      throw new Error("figma_set_auto_layout: mode must be VERTICAL|HORIZONTAL|NONE");
    }
    node.layoutMode = m;
    if (args.gap !== undefined || args.itemSpacing !== undefined) {
      node.itemSpacing = Math.max(0, +((args.gap !== undefined ? args.gap : args.itemSpacing)) || 0);
    }
    if (args.padding !== undefined) {
      var p = Math.max(0, +args.padding || 0);
      node.paddingTop = p; node.paddingBottom = p;
      node.paddingLeft = p; node.paddingRight = p;
    }
    return { id: node.id, layoutMode: node.layoutMode, updated: true };
  });
}

function handleSetPadding(args) {
  var keys = ["paddingTop", "paddingBottom", "paddingLeft", "paddingRight"];
  return lookupNode(args).then(function (node) {
    if (!("layoutMode" in node) || node.layoutMode === "NONE") {
      throw new Error("figma_set_padding: node has no active auto-layout (set layoutMode first)");
    }
    var any = false;
    if (args.padding !== undefined) {
      var p = Math.max(0, +args.padding || 0);
      node.paddingTop = p; node.paddingBottom = p;
      node.paddingLeft = p; node.paddingRight = p;
      any = true;
    }
    keys.forEach(function (k) {
      if (args[k] !== undefined) { node[k] = Math.max(0, +args[k] || 0); any = true; }
    });
    if (args.horizontal !== undefined) {
      node.paddingLeft = node.paddingRight = Math.max(0, +args.horizontal || 0);
      any = true;
    }
    if (args.vertical !== undefined) {
      node.paddingTop = node.paddingBottom = Math.max(0, +args.vertical || 0);
      any = true;
    }
    if (!any) throw new Error("figma_set_padding: pass padding, horizontal/vertical, or paddingTop/... ");
    return { id: node.id, updated: true };
  });
}

function handleSetAxis(args) {
  return lookupNode(args).then(function (node) {
    if (!("layoutMode" in node)) {
      throw new Error("figma_set_axis: node type " + node.type + " has no auto-layout");
    }
    var v = String(args.axis !== undefined ? args.axis : args.mode || "").toUpperCase();
    if (v !== "VERTICAL" && v !== "HORIZONTAL") {
      throw new Error("figma_set_axis: axis must be VERTICAL|HORIZONTAL");
    }
    node.layoutMode = v;
    return { id: node.id, layoutMode: node.layoutMode, updated: true };
  });
}

function handleSetCounterAxis(args) {
  var modes = ["MIN", "CENTER", "MAX", "BASELINE"];
  return lookupNode(args).then(function (node) {
    if (!("counterAxisAlignItems" in node)) {
      throw new Error("figma_set_counter_axis: node has no auto-layout counter axis");
    }
    var v = String(args.align !== undefined ? args.align : args.mode || "").toUpperCase();
    if (modes.indexOf(v) < 0) throw new Error("figma_set_counter_axis: align must be " + modes.join("|"));
    node.counterAxisAlignItems = v;
    return { id: node.id, updated: true };
  });
}

function handleSetPrimaryAxis(args) {
  var modes = ["MIN", "CENTER", "MAX", "SPACE_BETWEEN"];
  return lookupNode(args).then(function (node) {
    if (!("primaryAxisAlignItems" in node)) {
      throw new Error("figma_set_primary_axis: node has no auto-layout primary axis");
    }
    var v = String(args.justify !== undefined ? args.justify : args.mode || "").toUpperCase();
    if (modes.indexOf(v) < 0) throw new Error("figma_set_primary_axis: justify must be " + modes.join("|"));
    node.primaryAxisAlignItems = v;
    return { id: node.id, updated: true };
  });
}

function handleSetResizeMode(args) {
  // Per-child sizing inside auto-layout: hug (FIXED) vs fill (STRETCH/layoutGrow).
  return lookupNode(args).then(function (node) {
    var v = String(args.mode !== undefined ? args.mode : args.sizing || "").toUpperCase();
    if (v !== "HUG" && v !== "FILL" && v !== "FIXED") {
      throw new Error("figma_set_resize: mode must be HUG|FILL|FIXED");
    }
    if ("layoutAlign" in node) {
      node.layoutAlign = (v === "FILL") ? "STRETCH" : "INHERIT";
    }
    if ("layoutGrow" in node) {
      node.layoutGrow = (v === "FILL") ? 1 : 0;
    }
    return { id: node.id, mode: v, updated: true };
  });
}

// ── Group / align / distribute ─────────────────────────────────────────

function handleGroupNodes(args) {
  var ids = args && (args.nodeIds || args.ids);
  return lookupNodes(ids).then(function (nodes) {
    if (nodes.length < 2) throw new Error("figma_group_nodes: need at least 2 nodes");
    var holder = nodes[0].parent;
    if (args && args.parentId) {
      return figma.getNodeByIdAsync(String(args.parentId)).then(function (p) {
        if (!p) throw new Error("figma_group_nodes: no parent with id " + safeStr(args.parentId, 80));
        var g = figma.group(nodes, p);
        if (args.name !== undefined) g.name = safeStr(args.name, 120);
        return { id: g.id, name: safeStr(g.name, 120), grouped: nodes.length };
      });
    }
    var g = figma.group(nodes, holder);
    if (args && args.name !== undefined) g.name = safeStr(args.name, 120);
    return { id: g.id, name: safeStr(g.name, 120), grouped: nodes.length };
  });
}

function handleUngroup(args) {
  return lookupNode(args).then(function (node) {
    if (node.type !== "GROUP" && node.type !== "FRAME") {
      throw new Error("figma_ungroup: node type " + node.type + " is not a GROUP");
    }
    var kids = [];
    try { kids = (node.children || []).slice(); } catch (e) {}
    figma.ungroup(node);
    return { ungrouped: true, released: kids.length };
  });
}

function handleAlignNodes(args) {
  var modes = ["LEFT", "CENTER_H", "RIGHT", "TOP", "CENTER_V", "BOTTOM"];
  var mode = String((args && (args.align || args.mode)) || "").toUpperCase();
  if (modes.indexOf(mode) < 0) {
    return Promise.reject(new Error("figma_align_nodes: align must be " + modes.join("|")));
  }
  return lookupNodes(args && (args.nodeIds || args.ids)).then(function (nodes) {
    if (nodes.length < 2) throw new Error("figma_align_nodes: need at least 2 nodes");
    var ref = null;
    if (args && args.relativeTo === "parent") {
      var pb = absBox(nodes[0].parent);
      ref = pb.width > 0 ? pb : null;
    }
    if (!ref) {
      var xs = nodes.map(function (n) { return absBox(n).x; });
      var xe = nodes.map(function (n) { var b = absBox(n); return b.x + b.width; });
      var ys = nodes.map(function (n) { return absBox(n).y; });
      var ye = nodes.map(function (n) { var b = absBox(n); return b.y + b.height; });
      ref = { x: Math.min.apply(null, xs), y: Math.min.apply(null, ys),
              right: Math.max.apply(null, xe), bottom: Math.max.apply(null, ye) };
      ref.width = ref.right - ref.x; ref.height = ref.bottom - ref.y;
    } else {
      ref.right = ref.x + ref.width; ref.bottom = ref.y + ref.height;
    }
    nodes.forEach(function (n) {
      var b = absBox(n);
      if (mode === "LEFT") placeAbsolute(n, ref.x, b.y);
      else if (mode === "RIGHT") placeAbsolute(n, ref.right - b.width, b.y);
      else if (mode === "CENTER_H") placeAbsolute(n, ref.x + (ref.width - b.width) / 2, b.y);
      else if (mode === "TOP") placeAbsolute(n, b.x, ref.y);
      else if (mode === "BOTTOM") placeAbsolute(n, b.x, ref.bottom - b.height);
      else if (mode === "CENTER_V") placeAbsolute(n, b.x, ref.y + (ref.height - b.height) / 2);
    });
    return { align: mode, count: nodes.length, updated: true };
  });
}

function handleDistributeNodes(args) {
  var dir = String((args && (args.direction || args.axis)) || "HORIZONTAL").toUpperCase();
  if (dir !== "HORIZONTAL" && dir !== "VERTICAL") {
    return Promise.reject(new Error("figma_distribute_nodes: direction must be HORIZONTAL|VERTICAL"));
  }
  return lookupNodes(args && (args.nodeIds || args.ids)).then(function (nodes) {
    if (nodes.length < 3) throw new Error("figma_distribute_nodes: need at least 3 nodes");
    var horiz = dir === "HORIZONTAL";
    var sorted = nodes.slice().sort(function (a, b) {
      return (horiz ? absBox(a).x - absBox(b).x : absBox(a).y - absBox(b).y);
    });
    var lo = horiz ? absBox(sorted[0]).x : absBox(sorted[0]).y;
    var last = sorted[sorted.length - 1];
    var hi = (horiz ? absBox(last).x : absBox(last).y) +
      (horiz ? absBox(last).width : absBox(last).height);
    var sizes = sorted.map(function (n) {
      var b = absBox(n); return horiz ? b.width : b.height;
    });
    var total = sizes.reduce(function (a, b) { return a + b; }, 0);
    var gap = (args && args.gap !== undefined) ? Math.max(0, +args.gap || 0)
      : Math.max(0, (hi - lo - total) / (sorted.length - 1));
    var cursor = lo;
    sorted.forEach(function (n, i) {
      var b = absBox(n);
      if (horiz) placeAbsolute(n, cursor, b.y);
      else placeAbsolute(n, b.x, cursor);
      cursor += sizes[i] + gap;
    });
    return { direction: dir, gap: Math.round(gap * 100) / 100, count: nodes.length, updated: true };
  });
}

// ── Components ───────────────────────────────────────────────────────

function handleCreateComponent(args) {
  var ids = args && (args.nodeIds || args.ids);
  var make = function (kids, holder) {
    var comp = figma.createComponent();
    kids.forEach(function (k) { comp.appendChild(k); });
    if (holder && holder !== comp) {
      try { holder.appendChild(comp); } catch (e) {}
    }
    if (args && args.name !== undefined) comp.name = safeStr(args.name, 120);
    return { id: comp.id, name: safeStr(comp.name, 120), children: kids.length };
  };
  if (!ids) {
    var comp = figma.createComponent();
    if (args && args.name !== undefined) comp.name = safeStr(args.name, 120);
    return Promise.resolve({ id: comp.id, name: safeStr(comp.name, 120), children: 0 });
  }
  return lookupNodes(ids).then(function (nodes) {
    return make(nodes, nodes[0].parent);
  });
}

function handleCreateInstance(args) {
  var id = args && (args.componentId || args.nodeId || args.id);
  if (!id) return Promise.reject(new Error("figma_create_instance: 'componentId' is required"));
  return figma.getNodeByIdAsync(String(id)).then(function (comp) {
    if (!comp) throw new Error("figma_create_instance: no component with id " + safeStr(id, 80));
    if (typeof comp.createInstance !== "function") {
      throw new Error("figma_create_instance: node type " + comp.type + " is not a COMPONENT");
    }
    var inst = comp.createInstance();
    var holder = comp.parent || figma.currentPage;
    try { holder.appendChild(inst); } catch (e) {}
    if (args.x !== undefined || args.y !== undefined) {
      try {
        if (args.x !== undefined) inst.x = Math.round(+args.x || 0);
        if (args.y !== undefined) inst.y = Math.round(+args.y || 0);
      } catch (e) {}
    }
    return { id: inst.id, name: safeStr(inst.name, 120), componentId: comp.id };
  });
}

function handleDetachInstance(args) {
  return lookupNode(args).then(function (node) {
    if (node.type !== "INSTANCE") {
      throw new Error("figma_detach_instance: node type " + node.type + " is not an INSTANCE");
    }
    node.detachInstance();
    return { id: node.id, detached: true };
  });
}

function handleSetVariant(args) {
  if (!args || args.properties === undefined) {
    return Promise.reject(new Error("figma_set_variant: 'properties' ({name: value}) is required"));
  }
  return lookupNode(args).then(function (node) {
    if (node.type !== "INSTANCE") {
      throw new Error("figma_set_variant: node type " + node.type + " is not an INSTANCE");
    }
    var props = args.properties;
    if (typeof props !== "object" || Array.isArray(props)) {
      throw new Error("figma_set_variant: 'properties' must be an object map");
    }
    try {
      node.setProperties(props);
    } catch (e) {
      throw new Error("figma_set_variant failed: " + String((e && e.message) || e).slice(0, 200));
    }
    return { id: node.id, updated: true };
  });
}

// ── Plugin data / prototype ──────────────────────────────────────────

function handleSetPluginData(args) {
  if (!args || args.key === undefined || args.value === undefined) {
    return Promise.reject(new Error("figma_set_plugin_data: 'key' and 'value' (string) are required"));
  }
  return lookupNode(args).then(function (node) {
    node.setPluginData(String(args.key), String(args.value));
    return { id: node.id, key: String(args.key), updated: true };
  });
}

function handleGetPluginData(args) {
  return lookupNode(args).then(function (node) {
    if (args.key !== undefined) {
      return { id: node.id, key: String(args.key), value: node.getPluginData(String(args.key)) };
    }
    var keys = [];
    try { keys = node.getPluginDataKeys ? node.getPluginDataKeys() : []; } catch (e) {}
    var out = {};
    keys.forEach(function (k) {
      try { out[k] = node.getPluginData(k); } catch (e) {}
    });
    return { id: node.id, keys: keys, data: out };
  });
}

function handleSetReactions(args) {
  var destId = args && (args.destinationId || args.destination);
  return lookupNode(args).then(function (node) {
    if (!("reactions" in node)) {
      throw new Error("figma_set_reactions: node type " + node.type + " has no reactions");
    }
    if (args.clear === true || !destId) {
      node.reactions = [];
      return { id: node.id, cleared: true };
    }
    return figma.getNodeByIdAsync(String(destId)).then(function (dest) {
      if (!dest) throw new Error("figma_set_reactions: no destination with id " + safeStr(destId, 80));
      node.reactions = [{
        action: { type: "NODE", destinationId: dest.id, navigation: "NAVIGATE",
                  transition: { type: "DISSOLVE", duration: 0.2 } },
        trigger: { type: "ON_CLICK" },
      }];
      return { id: node.id, destinationId: dest.id, updated: true };
    });
  });
}

// ── Images (bytes only — no network; the manifest allowlists loopback) ─

function handleImportImage(args) {
  var b64 = args && (args.bytesB64 || args.bytes);
  if (!b64) {
    return Promise.reject(new Error("figma_import_image: 'bytesB64' is required (base64 PNG/JPG — URLs cannot be fetched: the plugin allowlists loopback only)"));
  }
  var bytes = (typeof b64 === "string") ? b64ToBytes(b64) : b64;
  if (!bytes || !bytes.length) {
    return Promise.reject(new Error("figma_import_image: empty image bytes"));
  }
  var parentId = args && (args.parentId || args.parent);
  var chained = parentId
    ? figma.getNodeByIdAsync(String(parentId))
    : Promise.resolve(figma.currentPage);
  return chained.then(function (holder) {
    if (!holder) throw new Error("figma_import_image: no parent with id " + safeStr(parentId, 80));
    var img;
    try {
      img = figma.createImage(new Uint8Array(bytes));
    } catch (e) {
      throw new Error("figma_import_image: bad image bytes: " + String((e && e.message) || e).slice(0, 160));
    }
    var rect = figma.createRectangle();
    rect.name = safeStr((args && args.name) || "Image", 120);
    var w = Math.max(1, Math.min(4000, Math.round(+((args && args.width)) || 400)));
    var h = Math.max(1, Math.min(4000, Math.round(+((args && args.height)) || 300)));
    try { rect.resize(w, h); } catch (e) {}
    rect.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: "FILL" }];
    try { holder.appendChild(rect); } catch (e) {
      throw new Error("figma_import_image: parent type " + holder.type + " cannot hold children");
    }
    return { id: rect.id, name: safeStr(rect.name, 120), parentId: holder.id, width: w, height: h };
  });
}

function handleSetImageFill(args) {
  var b64 = args && (args.bytesB64 || args.bytes);
  if (!b64) {
    return Promise.reject(new Error("figma_set_image_fill: 'bytesB64' is required (base64 PNG/JPG)"));
  }
  return lookupNode(args).then(function (node) {
    if (!("fills" in node)) {
      throw new Error("figma_set_image_fill: node type " + node.type + " has no fills");
    }
    var bytes = (typeof b64 === "string") ? b64ToBytes(b64) : b64;
    var img;
    try {
      img = figma.createImage(new Uint8Array(bytes));
    } catch (e) {
      throw new Error("figma_set_image_fill: bad image bytes: " + String((e && e.message) || e).slice(0, 160));
    }
    var mode = String((args && args.scaleMode) || "FILL").toUpperCase();
    if (["FILL", "FIT", "CROP", "TILE"].indexOf(mode) < 0) mode = "FILL";
    node.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: mode }];
    return { id: node.id, scaleMode: mode, updated: true };
  });
}

// ── Slices / export settings ─────────────────────────────────────────

function handleCreateSlice(args) {
  var slice = figma.createSlice();
  var w = Math.max(1, Math.min(4000, Math.round(+((args && args.width)) || 400)));
  var h = Math.max(1, Math.min(4000, Math.round(+((args && args.height)) || 300)));
  try { slice.resize(w, h); } catch (e) {}
  slice.x = Math.round(+((args && args.x)) || 0);
  slice.y = Math.round(+((args && args.y)) || 0);
  if (args && args.name !== undefined) slice.name = safeStr(args.name, 120);
  var parentId = args && (args.parentId || args.parent);
  var chained = parentId ? figma.getNodeByIdAsync(String(parentId)) : Promise.resolve(figma.currentPage);
  return chained.then(function (holder) {
    if (parentId && !holder) {
      throw new Error("figma_create_slice: no parent with id " + safeStr(parentId, 80));
    }
    try { holder.appendChild(slice); } catch (e) {}
    return { id: slice.id, name: safeStr(slice.name, 120), width: w, height: h };
  });
}

function handleSetExportSettings(args) {
  if (!args || args.settings === undefined) {
    return Promise.reject(new Error("figma_set_export_settings: 'settings' array is required ([{format, suffix?, scale?}])"));
  }
  return lookupNode(args).then(function (node) {
    if (!("exportSettings" in node)) {
      throw new Error("figma_set_export_settings: node type " + node.type + " has no export settings");
    }
    var list = Array.isArray(args.settings) ? args.settings : [args.settings];
    if (!list.length) {
      node.exportSettings = [];
      return { id: node.id, cleared: true };
    }
    var formats = ["PNG", "JPG", "SVG", "PDF"];
    node.exportSettings = list.slice(0, 8).map(function (s) {
      var f = String((s && s.format) || "PNG").toUpperCase();
      if (formats.indexOf(f) < 0) {
        throw new Error("figma_set_export_settings: format must be PNG|JPG|SVG|PDF, got " + safeStr(f, 20));
      }
      return {
        format: f,
        suffix: safeStr((s && (s.suffix || "")) || "", 20),
        constraint: { type: "SCALE", value: Math.max(0.5, Math.min(4, +((s && s.scale)) || 1)) },
      };
    });
    return { id: node.id, count: node.exportSettings.length, updated: true };
  });
}

function handleGetDocument() {
  var pages = [];
  try {
    pages = figma.root.children.slice(0, 50).map(function (p) {
      return { id: p.id, name: safeStr(p.name, 120), childCount: (p.children || []).length };
    });
  } catch (e) {}
  var sel = [];
  try {
    sel = (figma.currentPage.selection || []).slice(0, 20).map(function (n) {
      return { id: n.id, name: safeStr(n.name, 120), type: n.type };
    });
  } catch (e) {}
  return {
    name: safeStr(figma.root.name, 120),
    currentPage: { id: figma.currentPage.id, name: safeStr(figma.currentPage.name, 120) },
    pages: pages,
    selection: sel,
    pluginVersion: FIGMA_PLUGIN_VERSION,
  };
}

function executeTool(tool, args) {
  // Every handler returns a value or a Promise — the caller normalizes both.
  if (tool === "figma_create_frame") return handleCreateFrame(args);
  if (tool === "figma_create_node") return handleCreateNode(args);
  if (tool === "figma_get_nodes") return handleGetNodes(args);
  if (tool === "figma_set_properties") return handleSetProperties(args);
  if (tool === "figma_get_document") return handleGetDocument();
  if (tool === "figma_export_node") return { __async: "export", args: args };
  if (tool === "figma_delete_node") return handleDeleteNode(args);
  if (tool === "figma_duplicate_node") return handleDuplicateNode(args);
  if (tool === "figma_move_node") return handleMoveNode(args);
  if (tool === "figma_resize_node") return handleResizeNode(args);
  if (tool === "figma_set_text") return handleSetText(args);
  if (tool === "figma_set_font") return handleSetFont(args);
  if (tool === "figma_set_stroke") return handleSetStroke(args);
  if (tool === "figma_set_shadow") return handleSetShadow(args);
  if (tool === "figma_set_blur") return handleSetBlur(args);
  if (tool === "figma_set_constraint") return handleSetConstraint(args);
  if (tool === "figma_set_visible") return handleSetVisible(args);
  if (tool === "figma_set_locked") return handleSetLocked(args);
  if (tool === "figma_set_clips") return handleSetClips(args);
  if (tool === "figma_set_min_max") return handleSetMinMax(args);
  if (tool === "figma_set_auto_layout") return handleSetAutoLayout(args);
  if (tool === "figma_set_padding") return handleSetPadding(args);
  if (tool === "figma_set_axis") return handleSetAxis(args);
  if (tool === "figma_set_counter_axis") return handleSetCounterAxis(args);
  if (tool === "figma_set_primary_axis") return handleSetPrimaryAxis(args);
  if (tool === "figma_set_resize") return handleSetResizeMode(args);
  if (tool === "figma_group_nodes") return handleGroupNodes(args);
  if (tool === "figma_ungroup") return handleUngroup(args);
  if (tool === "figma_align_nodes") return handleAlignNodes(args);
  if (tool === "figma_distribute_nodes") return handleDistributeNodes(args);
  if (tool === "figma_create_component") return handleCreateComponent(args);
  if (tool === "figma_create_instance") return handleCreateInstance(args);
  if (tool === "figma_detach_instance") return handleDetachInstance(args);
  if (tool === "figma_set_variant") return handleSetVariant(args);
  if (tool === "figma_set_plugin_data") return handleSetPluginData(args);
  if (tool === "figma_get_plugin_data") return handleGetPluginData(args);
  if (tool === "figma_set_reactions") return handleSetReactions(args);
  if (tool === "figma_import_image") return handleImportImage(args);
  if (tool === "figma_set_image_fill") return handleSetImageFill(args);
  if (tool === "figma_create_slice") return handleCreateSlice(args);
  if (tool === "figma_set_export_settings") return handleSetExportSettings(args);
  if (tool === "create_ui_from_figma") {
    throw new Error("create_ui_from_figma runs in Roblox Studio, not Figma — the bridge routes it to the Studio queue");
  }
  throw new Error("unknown Figma tool: " + safeStr(tool, 80) + " (use figma_get_document to orient, figma_status for health)");
}

function doExport(args) {
  var nodeId = args && (args.nodeId || args.id);
  if (!nodeId) return Promise.reject(new Error("figma_export_node: 'nodeId' is required"));
  // dynamic-page documentAccess forbids the sync getNodeById.
  return figma.getNodeByIdAsync(String(nodeId)).then(function (node) {
    if (!node) throw new Error("figma_export_node: no node with id " + safeStr(nodeId, 80));
  if (typeof node.exportAsync !== "function") {
    throw new Error("figma_export_node: node type " + node.type + " cannot be exported");
  }
  var format = String((args && args.format) || "PNG").toUpperCase();
  if (format !== "PNG" && format !== "SVG" && format !== "PDF" && format !== "JPG") format = "PNG";
  var scale = Math.max(0.5, Math.min(4, parseFloat((args && args.scale) || 2) || 2));
  var settings = { format: format, constraint: { type: "SCALE", value: scale } };
  // exportAsync returns a Promise<Uint8Array>; the bytes are base64-encoded by
  // the UI thread (sandbox has no btoa in some hosts).
  return node.exportAsync(settings).then(function (bytes) {
    var w = 0, h = 0;
    try {
      if (node.absoluteBoundingBox) {
        w = Math.round(node.absoluteBoundingBox.width * scale);
        h = Math.round(node.absoluteBoundingBox.height * scale);
      }
    } catch (e) {}
    return { __bytes: bytes, format: format, scale: scale, width: w, height: h, nodeId: node.id };
  });
  });
}

// ── Message plumbing ─────────────────────────────────────────────────

figma.ui.onmessage = function (msg) {
  if (!msg || msg.type !== "execute") return;
  var id = msg.id, tool = msg.tool, args = msg.args || {};
  function reply(payload) {
    try { figma.ui.postMessage(payload); } catch (e) { /* UI closed */ }
  }
  var out;
  try {
    out = executeTool(tool, args);
  } catch (e) {
    reply({ type: "result", id: id, error: String((e && e.message) || e) });
    return;
  }
  // Handlers may return a plain value or a Promise (async node lookups).
  // Promise.resolve normalizes both; a rejection becomes an honest error.
  Promise.resolve(out).then(function (v) {
    if (v && v.__async === "export") {
      return doExport(v.args).then(function (r) {
        // Transfer bytes as a plain Array (structured-clone safe).
        var arr;
        try { arr = Array.from(r.__bytes); } catch (e) { arr = []; }
        reply({ type: "result", id: id, result: {
          nodeId: r.nodeId, format: r.format, scale: r.scale,
          width: r.width, height: r.height, bytes: arr,
        }});
      });
    }
    reply({ type: "result", id: id, result: v });
  }).catch(function (e) {
    reply({ type: "result", id: id, error: String((e && e.message) || e) });
  });
};

// Show the pairing UI on launch. The UI thread owns polling.
try {
  figma.showUI(__html__, { width: 300, height: 380, title: "RoLink Bridge" });
} catch (e) {
  // Headless/test hosts have no UI surface; handlers above still work.
}
