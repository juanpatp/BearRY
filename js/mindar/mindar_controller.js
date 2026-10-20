import * as THREE from 'three';
import { MindARThree } from 'mindar-image-three';

// Decodificador mínimo de MessagePack. El archivo .mind es un mapa msgpack
//   { v, dataList: [ { targetImage:{width,height}, trackingData, matchingData }, ... ] }
// y MindAR numera los anchors (targetIndex) en el mismo orden que dataList.
// El contenido binario (trackingData/matchingData) se omite para no retener MBs.
function decodeMsgpack(buffer) {
	const bytes = new Uint8Array(buffer);
	const view = new DataView(buffer);
	const textDecoder = new TextDecoder();
	let offset = 0;

	const take = (n) => { const s = textDecoder.decode(bytes.subarray(offset, offset + n)); offset += n; return s; };
	const map = (n) => { const o = {}; for (let i = 0; i < n; i++) { const k = value(); o[k] = value(); } return o; };
	const arr = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(value()); return a; };

	function value() {
		const t = bytes[offset++];
		if (t <= 0x7f) return t;
		if (t >= 0xe0) return t - 0x100;
		if ((t & 0xf0) === 0x80) return map(t & 0x0f);
		if ((t & 0xf0) === 0x90) return arr(t & 0x0f);
		if ((t & 0xe0) === 0xa0) return take(t & 0x1f);
		switch (t) {
			case 0xc0: return null;
			case 0xc2: return false;
			case 0xc3: return true;
			case 0xc4: { const n = view.getUint8(offset); offset += 1 + n; return null; }
			case 0xc5: { const n = view.getUint16(offset); offset += 2 + n; return null; }
			case 0xc6: { const n = view.getUint32(offset); offset += 4 + n; return null; }
			case 0xca: { const v = view.getFloat32(offset); offset += 4; return v; }
			case 0xcb: { const v = view.getFloat64(offset); offset += 8; return v; }
			case 0xcc: { const v = view.getUint8(offset); offset += 1; return v; }
			case 0xcd: { const v = view.getUint16(offset); offset += 2; return v; }
			case 0xce: { const v = view.getUint32(offset); offset += 4; return v; }
			case 0xcf: { const v = Number(view.getBigUint64(offset)); offset += 8; return v; }
			case 0xd0: { const v = view.getInt8(offset); offset += 1; return v; }
			case 0xd1: { const v = view.getInt16(offset); offset += 2; return v; }
			case 0xd2: { const v = view.getInt32(offset); offset += 4; return v; }
			case 0xd3: { const v = Number(view.getBigInt64(offset)); offset += 8; return v; }
			case 0xd9: return take(view.getUint8(offset++));
			case 0xda: { const n = view.getUint16(offset); offset += 2; return take(n); }
			case 0xdb: { const n = view.getUint32(offset); offset += 4; return take(n); }
			case 0xdc: { const n = view.getUint16(offset); offset += 2; return arr(n); }
			case 0xdd: { const n = view.getUint32(offset); offset += 4; return arr(n); }
			case 0xde: { const n = view.getUint16(offset); offset += 2; return map(n); }
			case 0xdf: { const n = view.getUint32(offset); offset += 4; return map(n); }
			default: throw new Error('msgpack: tipo no soportado 0x' + t.toString(16));
		}
	}

	return value();
}

class MindARController {

    constructor(container, threePlayer, debug = false) {
        this.container = container;
        this.threePlayer = threePlayer;
        this.debug = debug;
        this.isMobile = /Android|iPhone|iPod|iPad/i.test(navigator.userAgent);

        this.imageTargetSrc = 'assets/marker/targets.mind';

        this.mindar = null;
        this.anchors = [];
        this.started = false;

        this.listeners = {
            start: [],
            found: [],
            lost: [],
            update: [],
        };

        this.clickHandlerBound = false;
    }

	addListener(type, callback) { this.listeners[type].push(callback); }

	dispatch(type, event) {
		for (const listener of this.listeners[type]) {
			listener(event);
		}
	}

	// Tamaño en píxeles del marcador usado por un ImageTarget de la escena
	// (Gizmo.material.map = la imagen del marcador).
	getMarkerSize(imageTarget) {
		const texture = imageTarget?.target;
		const image = texture?.image || texture?.source?.data;
		if (!image) return null;
		const width = image.naturalWidth || image.width;
		const height = image.naturalHeight || image.height;
		if (!width || !height) return null;
		return { width, height };
	}

	// Descarga targets.mind y devuelve las dimensiones de cada target en el
	// MISMO orden en que MindAR asigna los targetIndex (dataList).
	async readMindDimensions(url) {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const root = decodeMsgpack(await res.arrayBuffer());
		const list = Array.isArray(root?.dataList) ? root.dataList : [];
		return list.map((t) => [t?.targetImage?.width, t?.targetImage?.height]);
	}

	// Índice declarado explícitamente desde el script de escena (lo más fiable):
	//   it.order     = 1..N  (1-based, igual que "Image1"/"Image2" del compilador)
	//   it.mindIndex = 0..N-1 (0-based)
	//   ó nombre del grupo "Image1"/"Image2"/...
	// Devuelve { index, method } o null.
	resolveExplicitMindIndex(imageTarget, mindDimensions) {
		let idx = null;
		let method = null;

		const order = imageTarget?.order;
		if (Number.isInteger(order) && order >= 1) {
			idx = order - 1;
			method = 'order';
		} else if (Number.isInteger(imageTarget?.mindIndex) && imageTarget.mindIndex >= 0) {
			idx = imageTarget.mindIndex;
			method = 'mindIndex';
		} else {
			const name = (imageTarget?.obj?.name ?? '').trim();
			const m = /^Image\s*(\d+)$/i.exec(name);
			if (m) { idx = Number(m[1]) - 1; method = 'name'; }
		}

		if (idx === null) return null;
		if (mindDimensions?.length && (idx < 0 || idx >= mindDimensions.length)) return null;
		return { index: idx, method };
	}

	// Empareja un ImageTarget de la escena con su índice real dentro del .mind.
	// Prioridad: 1) orden/índice explícito; 2) píxeles exactos; 3) aspecto.
	// Devuelve { index, method }.
	resolveMindIndex(imageTarget, mindDimensions, fallbackIndex, used) {
		const free = (i) => !used || !used.has(i);

		const explicit = this.resolveExplicitMindIndex(imageTarget, mindDimensions);
		if (explicit && free(explicit.index)) {
			return { index: explicit.index, method: explicit.method };
		}

		if (!mindDimensions?.length) return { index: fallbackIndex, method: 'fallback' };

		const size = this.getMarkerSize(imageTarget);
		if (!size) return { index: fallbackIndex, method: 'fallback' };

		let idx = mindDimensions.findIndex((d, i) => d && d[0] === size.width && d[1] === size.height && free(i));
		if (idx !== -1) return { index: idx, method: 'pixels' };

		const ratio = size.width / size.height;
		let best = -1, bestDelta = Infinity;
		for (let i = 0; i < mindDimensions.length; i++) {
			const [w, h] = mindDimensions[i] || [];
			if (!w || !h || !free(i)) continue;
			const delta = Math.abs(w / h - ratio);
			if (delta < bestDelta) { bestDelta = delta; best = i; }
		}
		if (best === -1) return { index: fallbackIndex, method: 'fallback' };
		return { index: best, method: 'aspect' };
	}

	// Aviso si el `order`/índice declarado no cuadra con las dimensiones del
	// marcador en targets.mind (típico: order invertido respecto al .mind).
	checkMarkerAgainstMind(sceneIndex, imageTarget, mindIndex, mindDimensions) {
		const size = this.getMarkerSize(imageTarget);
		const dim = mindDimensions?.[mindIndex];
		if (!size || !dim || !dim[0] || !dim[1]) return;

		if (size.width !== dim[0] || size.height !== dim[1]) {
			console.warn(
				`MindARController: desajuste de marcador. escena[${sceneIndex}] (${size.width}x${size.height}) ` +
				`vs targets.mind[${mindIndex}] (${dim[0]}x${dim[1]}). Revisá it.order: probablemente esté invertido respecto al .mind.`
			);
		}
	}


    async start() {

        if (this.started) return;

        // Limpia restos de un intento anterior (p.ej. un <video> huérfano).
        if (this.mindar) { this.stop(); }
        this.container.replaceChildren();

        const player = this.threePlayer;
        const imageTargets = player?.imageTargets;

		if (!imageTargets || !imageTargets.length) {
			throw new Error('player.imageTargets está vacío. Asegurate de que los scripts de la escena se ejecutaron.');
		}

		// Orden real de los marcadores dentro de targets.mind (dataList). MindAR
		// numera los anchors con ese orden, no con el orden de la escena.
		let mindDimensions = [];
		try {
			mindDimensions = await this.readMindDimensions(this.imageTargetSrc);
		} catch (e) {
			console.warn('MindARController: no se pudo interpretar targets.mind, se usa el orden de la escena.', e);
		}
		this.mindDimensions = mindDimensions;

		this.mindar = new MindARThree({
			container: this.container,
			imageTargetSrc: this.imageTargetSrc,
			filterMinCF: 0.001,
			filterBeta: 1000,
			warmupTolerance: 5,
			missTolerance: 5,
			uiLoading: 'no',
			uiScanning: 'no',
			uiError: 'yes',
		});

		const { scene, camera, renderer } = this.mindar;

		// Anchora el contenido AR de cada ImageTarget sobre el target.
		renderer.setPixelRatio(window.devicePixelRatio);
		renderer.setClearColor(0x000000, 0);

		this.targetMap = [];
		const usedMindIndexes = new Set();

		for (let i = 0; i < imageTargets.length; i++) {
			const it = imageTargets[i];

			// El índice de escena no tiene por qué coincidir con el del .mind.
			const resolved = this.resolveMindIndex(it, mindDimensions, i, usedMindIndexes);
			const mindIndex = resolved.index;
			usedMindIndexes.add(mindIndex);
			this.targetMap.push({ sceneIndex: i, mindIndex, method: resolved.method, order: it.order, markerSize: this.getMarkerSize(it) });
			console.log(`MindARController: ImageTarget escena[${i}] order=${it.order ?? '-'} -> target ${mindIndex} del .mind [${resolved.method}]`,
				this.getMarkerSize(it), mindDimensions[mindIndex]);
			this.checkMarkerAgainstMind(i, it, mindIndex, mindDimensions);

			const anchor = this.mindar.addAnchor(mindIndex);

			const content = it.arContent;
			if (content) {
				// El contenido se diseñó en el editor con el marcador en el suelo
				// (el "up" del editor es +Y). En MindAR el plano del target es XY
				// y +Z apunta hacia la cámara, así que rotamos +90° en X para que
				// el contenido quede en pie sobre el marcador. 1 unidad MindAR =
				// ancho del marcador (= 1.65 en el editor), por eso 1/1.65 ≈ 0.6.
				content.scale.setScalar(0.6);
				content.rotation.set(THREE.MathUtils.degToRad(90), 0, 0);

				anchor.group.add(content);
			}

			if (this.debug) {
				this.addMarkerDebugHelpers(anchor.group);
			}

			anchor.onTargetFound = () => {
				console.log(`MindARController: target detectado escena[${i}] (mind ${mindIndex})`);
				if (it.onFound) it.onFound.call(it);
				if (content) content.visible = true;
				this.dispatch('found', it);
			};

			anchor.onTargetLost = () => {
				console.log(`MindARController: target perdido escena[${i}] (mind ${mindIndex})`);
				if (it.onLost) it.onLost.call(it);
				if (content) content.visible = false;
				this.dispatch('lost', it);
			};

			this.anchors.push(anchor);
		}

        this.copyEnvironment(scene, player);
        this.copyLights(scene, player);
        this.copyRendererSettings(renderer, player);

        // El player sigue corriendo (events update/audio) pero deja de pintar.
        if (player?.setRenderEnabled) player.setRenderEnabled(false);

        this.bindClickEvents();

        try {
            await this.mindar.start();
        } catch (e) {
            this.mindar = null;
            this.started = false;
            const detail = (e && e.message) ? `: ${e.message}` : '. Comprobá que la cámara esté disponible y permitas el acceso';
            throw new Error(`No se pudo iniciar la cámara AR${detail}`);
        }

        renderer.setAnimationLoop(() => {
            this.dispatch('update', {});
            renderer.render(scene, camera);
        });

        this.started = true;
        this.dispatch('start', {});
    }

    stop() {
        if (!this.mindar) return;
        if (this.mindar.renderer?.setAnimationLoop) {
            this.mindar.renderer.setAnimationLoop(null);
        }
        this.mindar.stop();
        this.mindar = null;
        this.started = false;
    }

    switchCamera() {
        this.mindar?.switchCamera();
    }

    copyEnvironment(scene, player) {
        const appScene = player?.scene;
        if (!appScene) return;

        if (appScene.environment) {
            scene.environment = appScene.environment;
        }
        if (appScene.environmentIntensity !== undefined) {
            scene.environmentIntensity = appScene.environmentIntensity;
        }
        if (appScene.environmentRotation) {
            scene.environmentRotation.copy(appScene.environmentRotation);
        }
    }

    copyLights(scene, player) {
        const appScene = player?.scene;
        if (!appScene) return;

        appScene.traverse((obj) => {
            if (obj.isLight && obj !== appScene) {
                scene.add(obj.clone());
            }
        });
    }

    copyRendererSettings(renderer, player) {
        const appRenderer = player?.renderer;
        if (!appRenderer || !renderer) return;

        renderer.toneMapping = appRenderer.toneMapping;
        renderer.toneMappingExposure = appRenderer.toneMappingExposure;
        renderer.shadowMap.enabled = appRenderer.shadowMap?.enabled === true && !this.isMobile;
        renderer.shadowMap.type = appRenderer.shadowMap?.type ?? THREE.PCFShadowMap;
    }

    bindClickEvents() {
        if (this.clickHandlerBound) return;
        this.clickHandlerBound = true;

        if (window.PointerEvent) {
            document.addEventListener('pointerdown', (ev) => this.onArClick(ev));
        } else {
            document.addEventListener('touchstart', (ev) => {
                const touch = ev.changedTouches?.[0];
                if (touch) this.onArClick(touch);
            });
            document.addEventListener('click', (ev) => this.onArClick(ev));
        }
    }

    onArClick(ev) {
        const mindar = this.mindar;
        if (!mindar) return;

        const { scene, camera, renderer } = mindar;
        const canvas = renderer?.domElement;

        const rect = canvas.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((ev.clientX - rect.left) / rect.width) * 2 - 1,
            -((ev.clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, camera);

        const hits = raycaster.intersectObjects(scene.children, true);
        for (const hit of hits) {
            let obj = hit.object;
            while (obj) {
                if (obj.onClick && typeof obj.onClick === 'function' && this.objIsActive(obj)) {
                    obj.onClick();
                    return;
                }
                obj = obj.parent;
            }
        }
    }

    objIsActive(obj) {
        if (obj.visible === false) return false;
        let active = true;
        obj.traverseAncestors((ancestor) => {
            if (ancestor.visible === false) active = false;
        });
        return active;
    }

    addMarkerDebugHelpers(root) {
        const planeSize = 0.5;
        const planeGeometry = new THREE.PlaneGeometry(planeSize, planeSize, 1, 1);
        const planeMaterial = new THREE.MeshBasicMaterial({
            color: 0x00ffff,
            transparent: true,
            opacity: 0.25,
            side: THREE.DoubleSide,
            depthWrite: false,
        });

        root.add(new THREE.Mesh(planeGeometry, planeMaterial));
        root.add(new THREE.LineSegments(
            new THREE.EdgesGeometry(planeGeometry),
            new THREE.LineBasicMaterial({ color: 0x00ffff })
        ));
        root.add(new THREE.AxesHelper(0.3));
    }

}

export { MindARController };