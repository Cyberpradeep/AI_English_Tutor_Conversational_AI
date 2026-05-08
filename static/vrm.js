import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const canvas = document.getElementById('vrm-canvas');
const shadowEl = document.getElementById('model-shadow');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
    44,
    window.innerWidth / window.innerHeight,
    0.1, 20
);

const modelRoot = new THREE.Group();
scene.add(modelRoot);

// Default camera — slight bust-up framing
camera.position.set(0, 1.1, 3.8);
camera.lookAt(0, 0.8, 0);

const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
    precision: 'highp',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = false; // keep shadows off — not needed, saves memory

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

// ─── WEBGL CONTEXT LOSS RECOVERY ──────────────────────────────────────────────
// When GPU runs out of memory (e.g. after many audio reconnects), Three.js
// loses the WebGL context. We reload the VRM to rebuild all GPU resources.
canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('[vrm] WebGL context lost — will reload VRM on restore');
    vrm = null;
    vrmVisible = true;
}, false);

canvas.addEventListener('webglcontextrestored', () => {
    console.log('[vrm] WebGL context restored — reloading VRM');
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    loadVRM();
}, false);

// Lighting — warm, romantic feel
const ambientLight = new THREE.AmbientLight(0xfff0e8, 1.4);
scene.add(ambientLight);
const key = new THREE.DirectionalLight(0xffe8d0, 1.3);
key.position.set(0.5, 2, 2);
scene.add(key);
const fill = new THREE.DirectionalLight(0xd0e8ff, 0.5);
fill.position.set(-1, 0.5, 1);
scene.add(fill);
const backLight = new THREE.DirectionalLight(0xffeedd, 0.3);
backLight.position.set(0, 1, -2);
scene.add(backLight);

let vrm = null;
let vrmVisible = true;
let pendingShow = false;

// ─── STATE MACHINE ────────────────────────────────────────────────────────────
// States: idle | bot | user | excited | laugh | shy | sad | teasing | thinking | listening
let animState = 'idle';
let prevAnimState = 'idle';
let stateTransitionProgress = 0; // 0→1 blend when switching states
const STATE_BLEND_SPEED = 3.0;

// ─── TIMING ───────────────────────────────────────────────────────────────────
let prevTime = performance.now();
let elapsedTime = 0;
let lipPhase = 0;
let blinkTimer = 0;
let blinkInterval = 3.5;   // randomized each blink
let headNodTimer = 0;
let gestureTimer = 0;
let gesturePhase = 0;       // 0 = rest, 1 = active
let idleSwayPhase = 0;
let breathPhase = 0;

// ─── EMOTION SYSTEM ───────────────────────────────────────────────────────────
// Auto-detect emotion from text keywords → override animState briefly
let emotionOverride = null;
let emotionOverrideTimer = 0;

// ─── CAMERA MOTION ────────────────────────────────────────────────────────────
const CAM_BASE = new THREE.Vector3(0, 1.1, 3.8);
const CAM_TARGET = new THREE.Vector3(0, 0.8, 0);
let camOffset = new THREE.Vector3();

let isDragging = false;
let lastPointerX = 0;
let lastPointerY = 0;
let targetYaw = 0;
let targetPitch = 0;
const ROTATE_SPEED = 0.005;
const PITCH_LIMIT = Math.PI / 2 - 0.15;

canvas.style.touchAction = 'none';
canvas.addEventListener('pointerdown', (e) => {
    isDragging = true;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastPointerX;
    const dy = e.clientY - lastPointerY;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    targetYaw += dx * ROTATE_SPEED;
    targetPitch += dy * ROTATE_SPEED;
    targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, targetPitch));
});

canvas.addEventListener('pointerup', (e) => {
    isDragging = false;
    canvas.releasePointerCapture(e.pointerId);
});

canvas.addEventListener('pointercancel', (e) => {
    isDragging = false;
    canvas.releasePointerCapture(e.pointerId);
});

const loader = new GLTFLoader();
loader.register(parser => new VRMLoaderPlugin(parser));

function disposeVRM(v) {
    if (!v) return;
    modelRoot.remove(v.scene);
    v.scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach(m => {
                // Dispose every texture slot
                Object.values(m).forEach(val => {
                    if (val && val.isTexture) val.dispose();
                });
                m.dispose();
            });
        }
    });
}

function loadVRM() {
    if (vrm) { disposeVRM(vrm); vrm = null; }
    loader.load(
        '/static/voice_bot.vrm',
        (gltf) => {
            vrm = gltf.userData.vrm;
            VRMUtils.rotateVRM0(vrm);
            VRMUtils.removeUnnecessaryJoints(vrm.scene);
            vrm.scene.traverse((child) => {
                if (child.isSkinnedMesh) child.frustumCulled = false;
            });
            setIdlePose(vrm);
            vrm.scene.visible = vrmVisible;
            modelRoot.add(vrm.scene);
            targetYaw = 0;
            targetPitch = 0;
            console.log('[vrm] loaded ✨');
            _show();
        },
        (p) => console.log('[vrm] loading', ((p.loaded / p.total) * 100 | 0) + '%'),
        (e) => console.warn('[vrm] load error\n', e.message)
    );
}

loadVRM();

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const getBone = name => vrm?.humanoid?.getNormalizedBoneNode(name) ?? null;
const setExpr = (name, v) => vrm?.expressionManager?.setValue(name, Math.max(0, Math.min(1, v)));

function lerpAngle(current, target, t) {
    return current + (target - current) * t;
}

function smoothLerp(a, b, t) {
    return a + (b - a) * (t * t * (3 - 2 * t)); // smoothstep
}

function setArmPose(side, upper, lower, hand = { x: 0, y: 0, z: 0 }) {
    const upperArm = getBone(`${side}UpperArm`);
    const lowerArm = getBone(`${side}LowerArm`);
    const handBone = getBone(`${side}Hand`);
    if (upperArm) upperArm.rotation.set(upper.x, upper.y, upper.z);
    if (lowerArm) lowerArm.rotation.set(lower.x, lower.y, lower.z);
    if (handBone) handBone.rotation.set(hand.x, hand.y, hand.z);
}

// ─── IDLE POSE ────────────────────────────────────────────────────────────────
// VRM normalized T-pose = arms fully horizontal (rotation all zero).
// Lower arms to sides: upperArm.z ≈ +1.3 (left) / -1.3 (right)
// x controls forward/backward tilt of the arm.
function setIdlePose(v) {
    const h = v.humanoid;
    const nb = n => h.getNormalizedBoneNode(n);

    if (nb('leftUpperArm')) nb('leftUpperArm').rotation.set(0.05, 0, -1.3);
    if (nb('rightUpperArm')) nb('rightUpperArm').rotation.set(0.05, 0, 1.3);
    if (nb('leftLowerArm')) nb('leftLowerArm').rotation.set(0, 0, -0.1);
    if (nb('rightLowerArm')) nb('rightLowerArm').rotation.set(0, 0, 0.1);
    if (nb('leftHand')) nb('leftHand').rotation.set(0, 0, 0.05);
    if (nb('rightHand')) nb('rightHand').rotation.set(0, 0, -0.05);
    if (nb('spine')) nb('spine').rotation.x = 0.04;
    if (nb('chest')) nb('chest').rotation.x = -0.02;
    if (nb('neck')) nb('neck').rotation.x = 0.02;
    if (nb('head')) nb('head').rotation.x = 0.04;
}

// ─── BLINK SYSTEM ─────────────────────────────────────────────────────────────
// Returns blink value 0–1
function updateBlink(dt) {
    blinkTimer += dt;
    const c = blinkTimer % blinkInterval;
    const closeTime = 0.07;
    const openTime = 0.10;
    if (c > blinkInterval - closeTime - openTime) {
        const phase = c - (blinkInterval - closeTime - openTime);
        if (phase < closeTime) return phase / closeTime;
        else return 1 - (phase - closeTime) / openTime;
    }
    if (blinkTimer > blinkInterval) {
        blinkTimer = 0;
        blinkInterval = 2.5 + Math.random() * 3;
    }
    return 0;
}

// ─── BREATH SYSTEM ────────────────────────────────────────────────────────────
function updateBreath(dt, speed = 1.0) {
    breathPhase += dt * speed;
    const spine = getBone('spine');
    const chest = getBone('chest');
    if (spine) spine.rotation.x = 0.04 + Math.sin(breathPhase * 0.8) * 0.008;
    if (chest) chest.rotation.x = -0.02 + Math.sin(breathPhase * 0.8 + 0.3) * 0.006;
}

// ─── LIP SYNC ─────────────────────────────────────────────────────────────────
function updateLip(dt, intensity = 1.0) {
    lipPhase += dt * 10;
    // Multi-sine for more natural lip movement
    const raw = (Math.sin(lipPhase) * 0.45 + Math.sin(lipPhase * 2.3) * 0.25 + Math.sin(lipPhase * 0.7) * 0.3);
    const aa = Math.max(0, raw * 0.55 + 0.25) * intensity;
    const oh = Math.max(0, Math.sin(lipPhase * 0.5) * 0.2) * intensity;
    setExpr('aa', aa);
    setExpr('oh', oh);
}

function stopLip() {
    setExpr('aa', 0);
    setExpr('oh', 0);
    lipPhase = 0;
}

// ─── HEAD NOD (listening / affirmative) ───────────────────────────────────────
function updateHeadNod(dt, t, intensity = 0.5) {
    headNodTimer += dt;
    const head = getBone('head');
    const neck = getBone('neck');
    if (head) head.rotation.x = 0.04 + Math.sin(headNodTimer * 3.5) * 0.04 * intensity;
    if (neck) neck.rotation.x = 0.02 + Math.sin(headNodTimer * 3.5 + 0.2) * 0.02 * intensity;
}

// ─── IDLE ANIMATION ───────────────────────────────────────────────────────────
function doIdle(dt, t) {
    updateBreath(dt, 1.0);

    const spine = getBone('spine');
    if (spine) {
        spine.rotation.z = Math.sin(t * 0.9) * 0.008;
        spine.rotation.y = Math.sin(t * 0.45) * 0.006;
    }
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.y = Math.sin(t * 0.38) * 0.025;
        neck.rotation.z = Math.sin(t * 0.30) * 0.012;
    }
    const head = getBone('head');
    if (head) {
        head.rotation.y = Math.sin(t * 0.38) * 0.018;
    }
    // Arms hang naturally at sides — all axes set every frame
    const idleSwing = Math.sin(t * 0.55) * 0.015;
    setArmPose('left', { x: 0.05, y: 0, z: -1.3 - idleSwing }, { x: 0, y: 0, z: -0.1 }, { x: 0, y: 0, z: 0.05 });
    setArmPose('right', { x: 0.05, y: 0, z: 1.3 + idleSwing }, { x: 0, y: 0, z: 0.1 }, { x: 0, y: 0, z: -0.05 });

    setExpr('blink', updateBlink(dt));
}

// ─── BOT SPEAKING ─────────────────────────────────────────────────────────────
function doBot(dt, t) {
    updateBreath(dt, 1.3);
    updateLip(dt, 1.0);

    const talk = Math.sin(t * 3.2);
    const accent = Math.sin(t * 1.4);

    // Animated head tilt — engaged storyteller
    const head = getBone('head');
    if (head) {
        head.rotation.x = 0.05 + Math.sin(t * 4.2) * 0.028;
        head.rotation.y = Math.sin(t * 0.6) * 0.04;
        head.rotation.z = Math.sin(t * 0.4) * 0.018;
    }
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.y = Math.sin(t * 0.55) * 0.03;
        neck.rotation.z = Math.sin(t * 0.3) * 0.015;
    }
    const spine = getBone('spine');
    if (spine) {
        spine.rotation.z = Math.sin(t * 1.1) * 0.012;
        spine.rotation.x = 0.04 + Math.sin(t * 0.9) * 0.012;
        spine.rotation.y = Math.sin(t * 0.45) * 0.02;
    }
    // Expressive talk gestures
    setArmPose(
        'right',
        { x: -0.1 + accent * 0.08, y: 0.05, z: 0.95 + talk * 0.2 },
        { x: -0.25 + talk * 0.35, y: 0, z: 0.18 },
        { x: 0, y: 0, z: -0.2 + talk * 0.2 }
    );
    setArmPose(
        'left',
        { x: 0.05, y: -0.05, z: -1.2 + talk * 0.08 },
        { x: 0, y: 0, z: -0.1 },
        { x: 0, y: 0, z: 0.08 }
    );

    setExpr('blink', updateBlink(dt));
    setExpr('happy', 0.3 + Math.sin(t * 0.5) * 0.1);
}

// ─── USER SPEAKING (listening) ────────────────────────────────────────────────
function doUser(dt, t) {
    updateBreath(dt, 0.9);
    stopLip();
    updateHeadNod(dt, t, 0.6);

    const spine = getBone('spine');
    if (spine) {
        spine.rotation.x = 0.06; // lean slightly forward — attentive
        spine.rotation.z = Math.sin(t * 0.6) * 0.006;
    }
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.y = Math.sin(t * 0.3) * 0.02;
    }

    const listenSway = Math.sin(t * 0.6) * 0.03;
    setArmPose('left', { x: 0.02, y: 0.05, z: -1.15 }, { x: 0.02, y: 0, z: -0.2 }, { x: 0, y: 0, z: 0.1 });
    setArmPose('right', { x: 0.02, y: -0.05, z: 1.15 }, { x: 0.02, y: 0, z: 0.2 }, { x: 0, y: 0, z: -0.1 });
    if (spine) spine.rotation.y += listenSway;

    setExpr('blink', updateBlink(dt));
    setExpr('happy', 0.2);
}

// ─── EXCITED ANIMATION ────────────────────────────────────────────────────────
function doExcited(dt, t) {
    updateBreath(dt, 1.8);
    updateLip(dt, 0.7);

    const bounce = Math.sin(t * 8) * 0.04;

    const spine = getBone('spine');
    if (spine) {
        spine.rotation.x = 0.02 + Math.sin(t * 6) * 0.02;
        spine.rotation.z = Math.sin(t * 5) * 0.02;
        spine.rotation.y = Math.sin(t * 4) * 0.03;
    }
    // Bounce in head
    const head = getBone('head');
    if (head) {
        head.rotation.x = 0.04 + Math.sin(t * 7) * 0.04;
        head.rotation.z = Math.sin(t * 4) * 0.04;
    }
    // Arms raise and swing — excited celebration
    setArmPose(
        'left',
        { x: -0.55 + bounce, y: 0.1, z: -0.6 },
        { x: -0.2 + bounce, y: 0, z: -0.05 },
        { x: 0, y: 0, z: 0.1 }
    );
    setArmPose(
        'right',
        { x: -0.55 + bounce, y: -0.1, z: 0.6 },
        { x: -0.2 + bounce, y: 0, z: 0.05 },
        { x: 0, y: 0, z: -0.1 }
    );

    setExpr('blink', updateBlink(dt) * 0.4);
    setExpr('happy', 0.8 + Math.sin(t * 3) * 0.2);
    setExpr('surprised', 0.3 + Math.sin(t * 4) * 0.15);
}

// ─── LAUGH ANIMATION ──────────────────────────────────────────────────────────
function doLaugh(dt, t) {
    updateBreath(dt, 2.5);

    const giggle = Math.sin(t * 10) * 0.05;

    const spine = getBone('spine');
    if (spine) {
        spine.rotation.x = 0.1 + Math.sin(t * 9) * 0.06; // shaking laugh
        spine.rotation.z = Math.sin(t * 8) * 0.03;
        spine.rotation.y = giggle * 0.5;
    }
    const head = getBone('head');
    if (head) {
        head.rotation.x = 0.08 + Math.sin(t * 8) * 0.05;
        head.rotation.z = Math.sin(t * 6) * 0.03;
    }
    const neck = getBone('neck');
    if (neck) neck.rotation.x = 0.06 + Math.sin(t * 8) * 0.04;
    // Hands come up near face — laughing gesture
    setArmPose(
        'left',
        { x: -0.6, y: 0.05, z: -0.65 },
        { x: -0.4 + giggle, y: 0, z: -0.12 },
        { x: 0.1, y: 0, z: 0.2 }
    );
    setArmPose(
        'right',
        { x: -0.6, y: -0.05, z: 0.65 },
        { x: -0.4 + giggle, y: 0, z: 0.12 },
        { x: 0.1, y: 0, z: -0.2 }
    );

    // Laugh blink — eyes squint
    const blink = 0.5 + Math.sin(t * 9) * 0.4;
    setExpr('blinkLeft', blink * 0.6);
    setExpr('blinkRight', blink * 0.6);
    setExpr('happy', 1.0);
    setExpr('aa', Math.max(0, Math.sin(t * 8) * 0.7));
}

// ─── SHY / FLUSTERED ANIMATION ────────────────────────────────────────────────
function doShy(dt, t) {
    updateBreath(dt, 0.9);
    stopLip();

    const fidget = Math.sin(t * 3.5) * 0.04;

    const head = getBone('head');
    if (head) {
        // Look down-side — shy tilt
        head.rotation.x = 0.15 + Math.sin(t * 0.5) * 0.02;
        head.rotation.y = -0.12 + Math.sin(t * 0.3) * 0.015;
        head.rotation.z = 0.06;
    }
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.x = 0.08;
        neck.rotation.y = -0.06;
    }
    const spine = getBone('spine');
    if (spine) spine.rotation.x = 0.08; // slight inward lean
    // Arms pulled closer — closed shy pose, all axes
    setArmPose(
        'left',
        { x: 0.08, y: 0.15, z: -1.45 + fidget },
        { x: 0.05, y: 0, z: -0.2 },
        { x: 0, y: 0, z: 0.15 }
    );
    setArmPose(
        'right',
        { x: 0.08, y: -0.15, z: 1.45 - fidget },
        { x: 0.05, y: 0, z: 0.2 },
        { x: 0, y: 0, z: -0.15 }
    );

    setExpr('blink', updateBlink(dt) * 1.2);
    // Rosy shy expression
    setExpr('happy', 0.5 + Math.sin(t * 0.8) * 0.1);
    setExpr('blushLevel', 0.6); // if model supports it
}

// ─── SAD / COMFORTING ANIMATION ───────────────────────────────────────────────
function doSad(dt, t) {
    updateBreath(dt, 0.7);
    stopLip();

    const slump = Math.sin(t * 0.5) * 0.01;

    const head = getBone('head');
    if (head) {
        head.rotation.x = 0.12; // looking down
        head.rotation.y = Math.sin(t * 0.25) * 0.02;
        head.rotation.z = Math.sin(t * 0.2) * 0.015;
    }
    const spine = getBone('spine');
    if (spine) spine.rotation.x = 0.1 + slump; // slightly hunched
    const neck = getBone('neck');
    if (neck) neck.rotation.x = 0.06;
    setArmPose(
        'left',
        { x: 0.14, y: 0.02, z: -1.5 },
        { x: 0.15, y: 0, z: -0.2 },
        { x: 0.05, y: 0, z: 0.12 }
    );
    setArmPose(
        'right',
        { x: 0.14, y: -0.02, z: 1.5 },
        { x: 0.15, y: 0, z: 0.2 },
        { x: 0.05, y: 0, z: -0.12 }
    );

    setExpr('blink', updateBlink(dt));
    setExpr('sad', 0.6 + Math.sin(t * 0.4) * 0.1);
    setExpr('happy', 0);
}

// ─── TEASING ANIMATION ────────────────────────────────────────────────────────
function doTeasing(dt, t) {
    updateBreath(dt, 1.2);
    updateLip(dt, 0.5);

    const flick = Math.sin(t * 3.5) * 0.15;

    const head = getBone('head');
    if (head) {
        // Playful head tilt
        head.rotation.x = 0.06;
        head.rotation.y = 0.1 + Math.sin(t * 0.8) * 0.04;
        head.rotation.z = 0.1 + Math.sin(t * 1.2) * 0.02; // coy tilt
    }
    const spine = getBone('spine');
    if (spine) {
        spine.rotation.z = 0.03 + Math.sin(t * 0.9) * 0.01;
        spine.rotation.x = 0.05;
    }
    // Left arm down, right arm flicking — coy gesture
    setArmPose('left', { x: 0.05, y: 0, z: -1.3 }, { x: 0, y: 0, z: -0.1 }, { x: 0, y: 0, z: 0.08 });
    setArmPose(
        'right',
        { x: 0.02, y: 0.08, z: 0.9 },
        { x: -0.1 + flick, y: 0, z: 0.2 },
        { x: 0, y: 0, z: -0.2 + flick }
    );

    setExpr('blink', updateBlink(dt) * 0.8);
    setExpr('happy', 0.65 + Math.sin(t * 1.2) * 0.15);
    // Wink timing
    const winkCycle = t % 8;
    if (winkCycle > 7.6) setExpr('blinkRight', (winkCycle - 7.6) / 0.15);
    else if (winkCycle > 7.75) setExpr('blinkRight', 1 - (winkCycle - 7.75) / 0.15);
    else setExpr('blinkRight', 0);
}

// ─── THINKING ANIMATION ───────────────────────────────────────────────────────
function doThinking(dt, t) {
    updateBreath(dt, 0.8);
    stopLip();

    const tap = Math.sin(t * 2.2) * 0.05;

    const head = getBone('head');
    if (head) {
        // Tilted — thinking pose
        head.rotation.x = 0.05;
        head.rotation.y = 0.08 + Math.sin(t * 0.3) * 0.02;
        head.rotation.z = -0.05;
    }
    const neck = getBone('neck');
    if (neck) neck.rotation.y = 0.04;
    // Left arm down, right arm raised to chin — thinking pose, all axes
    setArmPose(
        'left',
        { x: 0.05, y: 0, z: -1.3 },
        { x: 0, y: 0, z: -0.1 },
        { x: 0, y: 0, z: 0.05 }
    );
    setArmPose(
        'right',
        { x: -0.85, y: 0.1, z: 0.4 },
        { x: -0.55 + tap, y: 0, z: 0.15 },
        { x: 0.15, y: 0, z: 0.05 }
    );

    setExpr('blink', updateBlink(dt));
    setExpr('happy', 0.1);
}

// ─── CAMERA GENTLE DRIFT ──────────────────────────────────────────────────────
function updateCamera(dt, t, stateKey) {
    let targetOffset = new THREE.Vector3(0, 0, 0);

    switch (stateKey) {
        case 'excited':
            targetOffset.set(Math.sin(t * 1.2) * 0.02, Math.sin(t * 0.9) * 0.01, 0);
            break;
        case 'shy':
            targetOffset.set(0.05, -0.03, 0.1); // slight pull back — give space
            break;
        case 'bot':
            targetOffset.set(Math.sin(t * 0.4) * 0.01, Math.sin(t * 0.3) * 0.008, 0);
            break;
        default:
            targetOffset.set(Math.sin(t * 0.25) * 0.008, Math.sin(t * 0.2) * 0.006, 0);
    }

    camOffset.lerp(targetOffset, dt * 1.5);
    camera.position.copy(CAM_BASE).add(camOffset);
    camera.lookAt(CAM_TARGET);
}

// ─── MAIN ANIMATION LOOP ──────────────────────────────────────────────────────
(function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min((now - prevTime) / 1000, 0.05);
    prevTime = now;
    elapsedTime += dt;
    const t = elapsedTime;

    modelRoot.rotation.y = lerpAngle(modelRoot.rotation.y, targetYaw, Math.min(1, dt * 10));
    modelRoot.rotation.x = lerpAngle(modelRoot.rotation.x, targetPitch, Math.min(1, dt * 10));

    if (vrm && vrmVisible) {
        // Emotion override countdown
        if (emotionOverride) {
            emotionOverrideTimer -= dt;
            if (emotionOverrideTimer <= 0) {
                emotionOverride = null;
            }
        }

        const activeState = emotionOverride || animState;

        switch (activeState) {
            case 'bot': doBot(dt, t); break;
            case 'user': doUser(dt, t); break;
            case 'excited': doExcited(dt, t); break;
            case 'laugh': doLaugh(dt, t); break;
            case 'shy': doShy(dt, t); break;
            case 'sad': doSad(dt, t); break;
            case 'teasing': doTeasing(dt, t); break;
            case 'thinking': doThinking(dt, t); break;
            default: doIdle(dt, t);
        }

        updateCamera(dt, t, activeState);

        vrm.expressionManager?.update();
        vrm.update(dt);
    }
    // Only render when visible — saves GPU when model is hidden
    if (vrmVisible || vrm === null) {
        renderer.render(scene, camera);
    }
})();

// ─── SHOW / HIDE ──────────────────────────────────────────────────────────────
function _show() {
    vrmVisible = true;
    vrm.scene.visible = true;
    shadowEl?.classList.remove('hidden');
}

window.vrmShow = () => {
    if (!vrm) { pendingShow = true; return; }
    _show();
};

window.vrmHide = () => {
    pendingShow = false;
    if (!vrm) return;
    vrmVisible = true;
    vrm.scene.visible = true;
    shadowEl?.classList.remove('hidden');
};

// ─── STATE SETTER ─────────────────────────────────────────────────────────────
/**
 * States:
 *   idle       – standing, gentle sway
 *   bot        – speaking, lip sync, gestures
 *   user       – listening, attentive nod
 *   excited    – bouncy, arms up, wide eyes
 *   laugh      – shaking laugh, squint eyes
 *   shy        – head down-tilt, pulled in
 *   sad        – hunched, sad expression
 *   teasing    – coy head tilt, wink
 *   thinking   – hand on chin, look away
 */
window.vrmSetState = (state) => {
    if (animState !== state) {
        prevAnimState = animState;
    }
    animState = state;

    // Clear lingering expressions on state change
    if (state !== 'bot') stopLip();
    if (state !== 'laugh') { setExpr('blinkLeft', 0); setExpr('blinkRight', 0); }
    if (state !== 'sad') setExpr('sad', 0);
    if (state !== 'shy') setExpr('blushLevel', 0);
    if (state !== 'excited' && state !== 'bot') setExpr('surprised', 0);
};

/**
 * Trigger a temporary emotion override (auto-reverts after `duration` seconds).
 * Called from transcript keyword detection in chat.js.
 */
window.vrmTriggerEmotion = (emotion, duration = 3.0) => {
    emotionOverride = emotion;
    emotionOverrideTimer = duration;
    // Re-reset arm poses so each emotion starts fresh
    if (vrm) setIdlePose(vrm);
};

// ─── KEYWORD → EMOTION DETECTOR ───────────────────────────────────────────────
// Call this from chat.js when assistant transcript arrives.
window.vrmDetectEmotion = (text) => {
    if (!text) return;
    const t = text.toLowerCase();

    // Laugh / funny
    if (/haha|lol|lmao|omg that's funny|stoppp|nooo|😂|😆/.test(t)) {
        window.vrmTriggerEmotion('laugh', 3.5);
    }
    // Excited / happy
    else if (/oh my god|wait really|that's so|amazing|love it|yay|excited|wow/.test(t)) {
        window.vrmTriggerEmotion('excited', 3.0);
    }
    // Shy / flustered
    else if (/aww|that's sweet|you're so|blush|that made me smile|❤️|😊/.test(t)) {
        window.vrmTriggerEmotion('shy', 4.0);
    }
    // Teasing
    else if (/stoppp|noo|you're kidding|tease|playful|😏|😜/.test(t)) {
        window.vrmTriggerEmotion('teasing', 3.5);
    }
    // Sad / comforting
    else if (/i'm sorry|that's sad|aww no|it's okay|i understand|😢|😔/.test(t)) {
        window.vrmTriggerEmotion('sad', 4.0);
    }
    // Thinking
    else if (/hmm|let me think|i wonder|actually|wait|well/.test(t)) {
        window.vrmTriggerEmotion('thinking', 2.5);
    }
};