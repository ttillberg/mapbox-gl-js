'use strict';

var ElementGroups = require('./element_groups');
var Anchor = require('../symbol/anchor');
var getAnchors = require('../symbol/get_anchors');
var resolveTokens = require('../util/token');
var Quads = require('../symbol/quads');
var Shaping = require('../symbol/shaping');
var resolveText = require('../symbol/resolve_text');
var resolveIcons = require('../symbol/resolve_icons');
var mergeLines = require('../symbol/mergelines');
var shapeText = Shaping.shapeText;
var shapeIcon = Shaping.shapeIcon;
var getGlyphQuads = Quads.getGlyphQuads;
var getIconQuads = Quads.getIconQuads;
var clipLine = require('../symbol/clip_line');
var Point = require('point-geometry');

var CollisionFeature = require('../symbol/collision_feature');

module.exports = SymbolBucket;

function SymbolBucket(buffers, layoutProperties, collision, overscaling, collisionDebug) {
    this.buffers = buffers;
    this.layoutProperties = layoutProperties;
    this.collision = collision;
    this.overscaling = overscaling;
    this.collisionDebug = collisionDebug;

    this.symbolInstances = [];

}

SymbolBucket.prototype.addFeatures = function() {
    var layout = this.layoutProperties;
    var features = this.features;
    var textFeatures = this.textFeatures;

    var horizontalAlign = 0.5,
        verticalAlign = 0.5;

    switch (layout['text-anchor']) {
        case 'right':
        case 'top-right':
        case 'bottom-right':
            horizontalAlign = 1;
            break;
        case 'left':
        case 'top-left':
        case 'bottom-left':
            horizontalAlign = 0;
            break;
    }

    switch (layout['text-anchor']) {
        case 'bottom':
        case 'bottom-right':
        case 'bottom-left':
            verticalAlign = 1;
            break;
        case 'top':
        case 'top-right':
        case 'top-left':
            verticalAlign = 0;
            break;
    }

    var justify = layout['text-justify'] === 'right' ? 1 :
        layout['text-justify'] === 'left' ? 0 :
        0.5;

    var oneEm = 24;
    var lineHeight = layout['text-line-height'] * oneEm;
    var maxWidth = layout['symbol-placement'] !== 'line' ? layout['text-max-width'] * oneEm : 0;
    var spacing = layout['text-letter-spacing'] * oneEm;
    var textOffset = [layout['text-offset'][0] * oneEm, layout['text-offset'][1] * oneEm];
    var fontstack = layout['text-font'];

    var geometries = [];
    for (var g = 0; g < features.length; g++) {
        geometries.push(features[g].loadGeometry());
    }

    if (layout['symbol-placement'] === 'line') {
        // Merge adjacent lines with the same text to improve labelling.
        // It's better to place labels on one long line than on many short segments.
        var merged = mergeLines(features, textFeatures, geometries);

        geometries = merged.geometries;
        features = merged.features;
        textFeatures = merged.textFeatures;
    }

    var shapedText, shapedIcon;

    for (var k = 0; k < features.length; k++) {
        if (!geometries[k]) continue;

        if (textFeatures[k]) {
            shapedText = shapeText(textFeatures[k], this.stacks[fontstack], maxWidth,
                    lineHeight, horizontalAlign, verticalAlign, justify, spacing, textOffset);
        } else {
            shapedText = null;
        }

        if (layout['icon-image']) {
            var iconName = resolveTokens(features[k].properties, layout['icon-image']);
            var image = this.icons[iconName];
            shapedIcon = shapeIcon(image, layout);

            if (image) {
                if (this.sdfIcons === undefined) {
                    this.sdfIcons = image.sdf;
                } else if (this.sdfIcons !== image.sdf) {
                    console.warn('Style sheet warning: Cannot mix SDF and non-SDF icons in one bucket');
                }
            }
        } else {
            shapedIcon = null;
        }

        if (shapedText || shapedIcon) {
            this.addFeature(geometries[k], shapedText, shapedIcon);
        }
    }

    this.placeFeatures(this.buffers, this.collisionDebug);
};

SymbolBucket.prototype.addFeature = function(lines, shapedText, shapedIcon) {
    var layout = this.layoutProperties;
    var collision = this.collision;

    var glyphSize = 24;

    var fontScale = layout['text-max-size'] / glyphSize,
        textBoxScale = collision.tilePixelRatio * fontScale,
        iconBoxScale = collision.tilePixelRatio * layout['icon-max-size'],
        symbolMinDistance = collision.tilePixelRatio * layout['symbol-min-distance'],
        avoidEdges = layout['symbol-avoid-edges'],
        textPadding = layout['text-padding'] * collision.tilePixelRatio,
        iconPadding = layout['icon-padding'] * collision.tilePixelRatio,
        textMaxAngle = layout['text-max-angle'] / 180 * Math.PI,
        textAlongLine = layout['text-rotation-alignment'] === 'map' && layout['symbol-placement'] === 'line',
        iconAlongLine = layout['icon-rotation-alignment'] === 'map' && layout['symbol-placement'] === 'line';

    if (layout['symbol-placement'] === 'line') {
        lines = clipLine(lines, 0, 0, 4096, 4096);
    }

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];

        // Calculate the anchor points around which you want to place labels
        var anchors = layout['symbol-placement'] === 'line' ?
            getAnchors(line, symbolMinDistance, textMaxAngle, shapedText, glyphSize, textBoxScale, this.overscaling) :
            [ new Anchor(line[0].x, line[0].y, 0) ];

        // For each potential label, create the placement features used to check for collisions, and the quads use for rendering.
        for (var j = 0, len = anchors.length; j < len; j++) {
            var anchor = anchors[j];

            var inside = !(anchor.x < 0 || anchor.x > 4096 || anchor.y < 0 || anchor.y > 4096);

            if (avoidEdges && !inside) continue;

            this.symbolInstances.push(new SymbolInstance(anchor, line, shapedText, shapedIcon, layout, inside,
                        textBoxScale, textPadding, textAlongLine,
                        iconBoxScale, iconPadding, iconAlongLine));
        }
    }
};

SymbolBucket.prototype.placeFeatures = function(buffers, collisionDebug) {

    // Calculate which labels can be shown and when they can be shown and
    // create the bufers used for rendering.

    this.buffers = buffers;

    var elementGroups = this.elementGroups = {
        text: new ElementGroups(buffers.glyphVertex, buffers.glyphElement),
        icon: new ElementGroups(buffers.iconVertex, buffers.iconElement),
        sdfIcons: this.sdfIcons
    };

    var layout = this.layoutProperties;
    var collision = this.collision;
    var maxScale = this.collision.maxScale;

    var textAlongLine = layout['text-rotation-alignment'] === 'map' && layout['symbol-placement'] === 'line';
    var iconAlongLine = layout['icon-rotation-alignment'] === 'map' && layout['symbol-placement'] === 'line';

    for (var p = 0; p < this.symbolInstances.length; p++) {
        var symbolInstance = this.symbolInstances[p];
        var hasText = symbolInstance.hasText;
        var hasIcon = symbolInstance.hasIcon;

        var iconWithoutText = layout['text-optional'] || !hasText,
            textWithoutIcon = layout['icon-optional'] || !hasIcon;


        // Calculate the scales at which the text and icon can be placed without collision.

        var glyphScale = hasText && !layout['text-allow-overlap'] ?
            collision.placeFeature(symbolInstance.textCollisionFeature) : collision.minScale;

        var iconScale = hasIcon && !layout['icon-allow-overlap'] ?
            collision.placeFeature(symbolInstance.iconCollisionFeature) : collision.minScale;


        // Combine the scales for icons and text.

        if (!iconWithoutText && !textWithoutIcon) {
            iconScale = glyphScale = Math.max(iconScale, glyphScale);
        } else if (!textWithoutIcon && glyphScale) {
            glyphScale = Math.max(iconScale, glyphScale);
        } else if (!iconWithoutText && iconScale) {
            iconScale = Math.max(iconScale, glyphScale);
        }


        // Insert final placement into collision tree and add glyphs/icons to buffers

        if (hasText) {
            if (!layout['text-ignore-placement']) {
                collision.insertFeature(symbolInstance.textCollisionFeature, glyphScale);
            }
            if (glyphScale <= maxScale) {
                this.addSymbols(buffers.glyphVertex, buffers.glyphElement, elementGroups.text,
                        symbolInstance.glyphQuads, glyphScale, layout['text-keep-upright'], textAlongLine);
            }
        }

        if (hasIcon) {
            if (!layout['icon-ignore-placement']) {
                collision.insertFeature(symbolInstance.iconCollisionFeature, iconScale);
            }
            if (iconScale <= maxScale) {
                this.addSymbols(buffers.iconVertex, buffers.iconElement, elementGroups.icon,
                        symbolInstance.iconQuads, iconScale, layout['icon-keep-upright'], iconAlongLine);
            }
        }

    }

    if (collisionDebug) this.addToDebugBuffers();
};

SymbolBucket.prototype.addSymbols = function(vertex, element, elementGroups, quads, scale, keepUpright, alongLine) {

    elementGroups.makeRoomFor(4 * quads.length);
    var elementGroup = elementGroups.current;

    var zoom = this.collision.zoom;
    var placementZoom = Math.log(scale) / Math.LN2 + zoom;
    var placementAngle = this.collision.angle + Math.PI;

    for (var k = 0; k < quads.length; k++) {

        var symbol = quads[k],
            angle = symbol.angle;

        // drop upside down versions of glyphs
        var a = (angle + placementAngle) % (Math.PI * 2);
        if (keepUpright && alongLine && (a <= Math.PI / 2 || a > Math.PI * 3 / 2)) continue;

        var tl = symbol.tl,
            tr = symbol.tr,
            bl = symbol.bl,
            br = symbol.br,
            tex = symbol.tex,
            anchor = symbol.anchor,

            minZoom = Math.max(zoom + Math.log(symbol.minScale) / Math.LN2, placementZoom),
            maxZoom = Math.min(zoom + Math.log(symbol.maxScale) / Math.LN2, 25);

        if (maxZoom <= minZoom) continue;

        // Lower min zoom so that while fading out the label it can be shown outside of collision-free zoom levels
        if (minZoom === placementZoom) minZoom = 0;

        var triangleIndex = vertex.index - elementGroup.vertexStartIndex;

        vertex.add(anchor.x, anchor.y, tl.x, tl.y, tex.x, tex.y, minZoom, maxZoom, placementZoom);
        vertex.add(anchor.x, anchor.y, tr.x, tr.y, tex.x + tex.w, tex.y, minZoom, maxZoom, placementZoom);
        vertex.add(anchor.x, anchor.y, bl.x, bl.y, tex.x, tex.y + tex.h, minZoom, maxZoom, placementZoom);
        vertex.add(anchor.x, anchor.y, br.x, br.y, tex.x + tex.w, tex.y + tex.h, minZoom, maxZoom, placementZoom);
        elementGroup.vertexLength += 4;

        element.add(triangleIndex, triangleIndex + 1, triangleIndex + 2);
        element.add(triangleIndex + 1, triangleIndex + 2, triangleIndex + 3);
        elementGroup.elementLength += 2;
    }

};

SymbolBucket.prototype.getDependencies = function(tile, actor, callback) {
    var firstdone = false;
    this.getTextDependencies(tile, actor, done);
    this.getIconDependencies(tile, actor, done);
    function done(err) {
        if (err || firstdone) return callback(err);
        firstdone = true;
    }
};

SymbolBucket.prototype.getIconDependencies = function(tile, actor, callback) {
    if (this.layoutProperties['icon-image']) {
        var features = this.features;
        var icons = resolveIcons(features, this.layoutProperties);

        if (icons.length) {
            actor.send('get icons', { icons: icons }, setIcons.bind(this));
        } else {
            callback();
        }
    } else {
        callback();
    }

    function setIcons(err, newicons) {
        if (err) return callback(err);
        this.icons = newicons;
        callback();
    }
};

SymbolBucket.prototype.getTextDependencies = function(tile, actor, callback) {
    var features = this.features;
    var fontstack = this.layoutProperties['text-font'];

    var stacks = this.stacks = tile.stacks;
    if (stacks[fontstack] === undefined) {
        stacks[fontstack] = {};
    }
    var stack = stacks[fontstack];

    var data = resolveText(features, this.layoutProperties, stack);
    this.textFeatures = data.textFeatures;

    actor.send('get glyphs', {
        uid: tile.uid,
        fontstack: fontstack,
        codepoints: data.codepoints
    }, function(err, newstack) {
        if (err) return callback(err);

        for (var codepoint in newstack) {
            stack[codepoint] = newstack[codepoint];
        }

        callback();
    });
};

SymbolBucket.prototype.addToDebugBuffers = function() {

    this.elementGroups.collisionBox = new ElementGroups(this.buffers.collisionBoxVertex);
    this.elementGroups.collisionBox.makeRoomFor(0);
    var buffer = this.buffers.collisionBoxVertex;
    var angle = -this.collision.angle;
    var yStretch = this.collision.yStretch;

    for (var j = 0; j < this.symbolInstances.length; j++) {
        for (var i = 0; i < 2; i++) {
            var feature = this.symbolInstances[j][i === 0 ? 'textCollisionFeature' : 'iconCollisionFeature'];
            if (!feature) continue;
            var boxes = feature.boxes;

            for (var b = 0; b < boxes.length; b++) {
                var box = boxes[b];
                var anchor = box.anchor;

                var tl = new Point(box.x1, box.y1 * yStretch)._rotate(angle);
                var tr = new Point(box.x2, box.y1 * yStretch)._rotate(angle);
                var bl = new Point(box.x1, box.y2 * yStretch)._rotate(angle);
                var br = new Point(box.x2, box.y2 * yStretch)._rotate(angle);

                var maxZoom = Math.max(0, Math.min(25, this.collision.zoom + Math.log(box.maxScale) / Math.LN2));
                var placementZoom = Math.max(0, Math.min(25, this.collision.zoom + Math.log(box.placementScale) / Math.LN2));

                buffer.add(anchor, tl, maxZoom, placementZoom);
                buffer.add(anchor, tr, maxZoom, placementZoom);
                buffer.add(anchor, tr, maxZoom, placementZoom);
                buffer.add(anchor, br, maxZoom, placementZoom);
                buffer.add(anchor, br, maxZoom, placementZoom);
                buffer.add(anchor, bl, maxZoom, placementZoom);
                buffer.add(anchor, bl, maxZoom, placementZoom);
                buffer.add(anchor, tl, maxZoom, placementZoom);

                this.elementGroups.collisionBox.current.vertexLength += 8;
            }
        }
    }
};

function SymbolInstance(anchor, line, shapedText, shapedIcon, layout, inside,
                        textBoxScale, textPadding, textAlongLine,
                        iconBoxScale, iconPadding, iconAlongLine) {

    this.hasText = !!shapedText;
    this.hasIcon = !!shapedIcon;

    if (this.hasText) {
        this.glyphQuads = inside ? getGlyphQuads(anchor, shapedText, textBoxScale, line, layout, textAlongLine) : [];
        this.textCollisionFeature = new CollisionFeature(line, anchor, shapedText, textBoxScale, textPadding, textAlongLine);
    }

    if (this.hasIcon) {
        this.iconQuads = inside ? getIconQuads(anchor, shapedIcon, iconBoxScale, line, layout, iconAlongLine) : [];
        this.iconCollisionFeature = new CollisionFeature(line, anchor, shapedIcon, iconBoxScale, iconPadding, iconAlongLine);
    }
}
