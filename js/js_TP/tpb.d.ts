// js_TP/tpb.d.ts
//
// Автономные типы для локальной сборки tpb.js.
// Не зависят ни от пакета `three`, ни от @types/three.

export namespace THREE {

    // ----------------------------------------------------------------
    // Math
    // ----------------------------------------------------------------

    export class Vector2 {
        constructor(x?: number, y?: number);
        [key: string]: any;
        x: number;
        y: number;
        set(x: number, y: number): this;
        copy(v: Vector2): this;
        clone(): Vector2;
        add(v: Vector2): this;
        sub(v: Vector2): this;
        subVectors(a: Vector2, b: Vector2): this;
        multiplyScalar(s: number): this;
        length(): number;
        distanceTo(v: Vector2): number;
    }

    export class Vector3 {
        constructor(x?: number, y?: number, z?: number);
        [key: string]: any;
        x: number;
        y: number;
        z: number;
        set(x: number, y: number, z: number): this;
        copy(v: Vector3): this;
        clone(): Vector3;
        add(v: Vector3): this;
        addVectors(a: Vector3, b: Vector3): this;
        addScaledVector(v: Vector3, s: number): this;
        sub(v: Vector3): this;
        subVectors(a: Vector3, b: Vector3): this;
        multiplyScalar(s: number): this;
        applyMatrix4(m: Matrix4): this;
        applyQuaternion(q: Quaternion): this;
        normalize(): this;
        length(): number;
        lengthSq(): number;
        distanceTo(v: Vector3): number;
        distanceToSquared(v: Vector3): number;
        project(camera: Camera): this;
        unproject(camera: Camera): this;
        lerp(v: Vector3, t: number): this;
        lerpVectors(a: Vector3, b: Vector3, t: number): this;
        crossVectors(a: Vector3, b: Vector3): this;
        dot(v: Vector3): number;
        setFromMatrixPosition(m: Matrix4): this;
    }

    export class Vector4 {
        constructor(x?: number, y?: number, z?: number, w?: number);
        [key: string]: any;
        x: number;
        y: number;
        z: number;
        w: number;
    }

    export class Quaternion {
        constructor(x?: number, y?: number, z?: number, w?: number);
        [key: string]: any;
    }

    export class Matrix4 {
        constructor();
        [key: string]: any;
        elements: number[];
        makeRotationX(a: number): this;
        makeRotationY(a: number): this;
        makeRotationZ(a: number): this;
        multiplyMatrices(a: Matrix4, b: Matrix4): this;
        invert(): this;
        identity(): this;
    }

    export class Euler {
        constructor(x?: number, y?: number, z?: number);
        [key: string]: any;
        x: number;
        y: number;
        z: number;
    }

    export class Color {
        constructor(color?: number | string | Color);
        [key: string]: any;
        r: number;
        g: number;
        b: number;
        set(color: number | string | Color): this;
        setHex(hex: number): this;
        setRGB(r: number, g: number, b: number): this;
        getHex(): number;
        copy(c: Color): this;
        clone(): Color;
    }

    export const MathUtils: {
        [key: string]: any;
        clamp(v: number, min: number, max: number): number;
        lerp(a: number, b: number, t: number): number;
        degToRad(d: number): number;
        radToDeg(r: number): number;
    };

    // ----------------------------------------------------------------
    // Scene graph
    // ----------------------------------------------------------------

    export class Object3D {
        constructor();
        [key: string]: any;
        id: number;
        uuid: string;
        name: string;
        parent: Object3D | null;
        children: Object3D[];
        position: Vector3;
        rotation: Euler;
        scale: Vector3;
        quaternion: Quaternion;
        matrix: Matrix4;
        matrixWorld: Matrix4;
        visible: boolean;
        renderOrder: number;
        frustumCulled: boolean;
        userData: Record<string, any>;
        add(...objs: Object3D[]): this;
        remove(...objs: Object3D[]): this;
        clear(): this;
        traverse(cb: (obj: Object3D) => void): void;
        traverseVisible(cb: (obj: Object3D) => void): void;
        updateMatrixWorld(force?: boolean): void;
        updateWorldMatrix(updateParents?: boolean, updateChildren?: boolean): void;
        getWorldPosition(target: Vector3): Vector3;
        getWorldDirection(target: Vector3): Vector3;
    }

    export class Group extends Object3D {}
    export class Scene extends Object3D {
        background: Color | Texture | null;
        fog: any;
    }

    export class Mesh extends Object3D {
        constructor(geometry?: BufferGeometry, material?: Material);
        geometry: BufferGeometry;
        material: Material;
    }

    export class Line extends Object3D {
        constructor(geometry?: BufferGeometry, material?: Material);
        geometry: BufferGeometry;
        material: Material;
    }

    export class LineSegments extends Line {
        constructor(geometry?: BufferGeometry, material?: Material);
    }

    export class LineLoop extends Line {
        constructor(geometry?: BufferGeometry, material?: Material);
    }

    export class Points extends Object3D {
        constructor(geometry?: BufferGeometry, material?: Material);
        geometry: BufferGeometry;
        material: Material;
    }

    export class Sprite extends Object3D {
        constructor(material?: Material);
        material: Material;
    }

    // ----------------------------------------------------------------
    // Geometry
    // ----------------------------------------------------------------

    export class BufferAttribute {
        constructor(array: ArrayLike<number> | ArrayBufferView, itemSize: number, normalized?: boolean);
        [key: string]: any;
        array: ArrayLike<number>;
        itemSize: number;
        count: number;
        needsUpdate: boolean;
        setUsage(usage: number): this;
        dispose(): void;
    }

    export class Float32BufferAttribute extends BufferAttribute {
        constructor(array: ArrayLike<number> | ArrayBufferView, itemSize: number);
    }

    export class Uint32BufferAttribute extends BufferAttribute {
        constructor(array: ArrayLike<number> | ArrayBufferView, itemSize: number);
    }

    export class BufferGeometry {
        constructor();
        [key: string]: any;
        id: number;
        uuid: string;
        attributes: Record<string, BufferAttribute>;
        index: BufferAttribute | null;
        boundingSphere: any;
        boundingBox: any;
        setAttribute(name: string, attribute: BufferAttribute): this;
        getAttribute(name: string): BufferAttribute | undefined;
        deleteAttribute(name: string): this;
        setIndex(index: BufferAttribute | number[] | null): this;
        computeBoundingSphere(): void;
        computeBoundingBox(): void;
        computeVertexNormals(): void;
        rotateX(angle: number): this;
        rotateY(angle: number): this;
        rotateZ(angle: number): this;
        translate(x: number, y: number, z: number): this;
        applyMatrix4(m: Matrix4): this;
        dispose(): void;
    }

    export class CircleGeometry extends BufferGeometry {
        constructor(radius?: number, segments?: number, thetaStart?: number, thetaLength?: number);
    }
    export class PlaneGeometry extends BufferGeometry {
        constructor(width?: number, height?: number, widthSegments?: number, heightSegments?: number);
    }
    export class BoxGeometry extends BufferGeometry {
        constructor(width?: number, height?: number, depth?: number, ...rest: number[]);
    }
    export class SphereGeometry extends BufferGeometry {
        constructor(radius?: number, widthSegments?: number, heightSegments?: number);
    }

    // ----------------------------------------------------------------
    // Materials & textures
    // ----------------------------------------------------------------

    export class Material {
        constructor();
        [key: string]: any;
        id: number;
        uuid: string;
        visible: boolean;
        transparent: boolean;
        opacity: number;
        depthTest: boolean;
        depthWrite: boolean;
        side: number;
        dispose(): void;
    }

    export class MeshBasicMaterial extends Material {
        constructor(params?: Record<string, any>);
        color: Color;
    }
    export class MeshLambertMaterial extends Material {
        constructor(params?: Record<string, any>);
        color: Color;
    }
    export class MeshPhongMaterial extends Material {
        constructor(params?: Record<string, any>);
        color: Color;
    }
    export class MeshStandardMaterial extends Material {
        constructor(params?: Record<string, any>);
        color: Color;
        roughness: number;
        metalness: number;
        emissive: Color;
        emissiveIntensity: number;
    }
    export class LineBasicMaterial extends Material {
        constructor(params?: Record<string, any>);
        color: Color;
    }
    export class LineDashedMaterial extends LineBasicMaterial {
        constructor(params?: Record<string, any>);
        dashSize: number;
        gapSize: number;
        scale: number;
    }
    export class SpriteMaterial extends Material {
        constructor(params?: Record<string, any>);
    }

    export class Texture {
        constructor();
        [key: string]: any;
        needsUpdate: boolean;
        dispose(): void;
    }
    export class CanvasTexture extends Texture {
        constructor(canvas?: any);
    }
    export class DataTexture extends Texture {
        constructor(data?: ArrayBufferView, width?: number, height?: number);
    }

    // ----------------------------------------------------------------
    // Cameras & renderer
    // ----------------------------------------------------------------

    export class Camera extends Object3D {
        matrixWorldInverse: Matrix4;
        projectionMatrix: Matrix4;
        projectionMatrixInverse: Matrix4;
    }
    export class PerspectiveCamera extends Camera {
        constructor(fov?: number, aspect?: number, near?: number, far?: number);
        fov: number;
        aspect: number;
        near: number;
        far: number;
        updateProjectionMatrix(): void;
    }
    export class OrthographicCamera extends Camera {
        constructor(left?: number, right?: number, top?: number, bottom?: number, near?: number, far?: number);
        updateProjectionMatrix(): void;
    }

    export class WebGLRenderer {
        constructor(params?: {
            antialias?: boolean;
            alpha?: boolean;
            powerPreference?: string;
            canvas?: HTMLCanvasElement;
            [key: string]: any;
        });
        [key: string]: any;
        domElement: HTMLCanvasElement;
        setSize(w: number, h: number, updateStyle?: boolean): void;
        getSize(target: Vector2): Vector2;
        setPixelRatio(ratio: number): void;
        getPixelRatio(): number;
        setClearColor(color: number | string | Color, alpha?: number): void;
        setAnimationLoop(cb: ((t: number) => void) | null): void;
        render(scene: Scene, camera: Camera): void;
        compile(scene: Scene, camera: Camera): void;
        dispose(): void;
    }

    // ----------------------------------------------------------------
    // Raycasting
    // ----------------------------------------------------------------

    export class Ray {
        origin: Vector3;
        direction: Vector3;
        intersectPlane(plane: Plane, target: Vector3): Vector3 | null;
        intersectSphere(center: Vector3, radius: number, target: Vector3): Vector3 | null;
        at(t: number, target: Vector3): Vector3;
    }

    export class Plane {
        constructor(normal?: Vector3, constant?: number);
        [key: string]: any;
        normal: Vector3;
        constant: number;
        set(normal: Vector3, constant: number): this;
        setFromNormalAndCoplanarPoint(normal: Vector3, point: Vector3): this;
        setFromCoplanarPoints(a: Vector3, b: Vector3, c: Vector3): this;
        distanceToPoint(p: Vector3): number;
        projectPoint(p: Vector3, target: Vector3): Vector3;
    }

    export interface RaycastIntersection {
        distance: number;
        point: Vector3;
        object: Object3D;
        face?: any;
        faceIndex?: number;
        uv?: Vector2;
        [key: string]: any;
    }

    export class Raycaster {
        constructor(origin?: Vector3, direction?: Vector3, near?: number, far?: number);
        [key: string]: any;
        ray: Ray;
        near: number;
        far: number;
        set(origin: Vector3, direction: Vector3): this;
        setFromCamera(coords: Vector2, camera: Camera): void;
        intersectObject(obj: Object3D, recursive?: boolean, optionalTarget?: RaycastIntersection[]): RaycastIntersection[];
        intersectObjects(objs: Object3D[], recursive?: boolean, optionalTarget?: RaycastIntersection[]): RaycastIntersection[];
    }

    // ----------------------------------------------------------------
    // Lights
    // ----------------------------------------------------------------

    export class Light extends Object3D {
        constructor(color?: number | string | Color, intensity?: number);
        color: Color;
        intensity: number;
    }
    export class AmbientLight extends Light {
        constructor(color?: number | string | Color, intensity?: number);
    }
    export class DirectionalLight extends Light {
        constructor(color?: number | string | Color, intensity?: number);
        target: Object3D;
        shadow: any;
    }
    export class HemisphereLight extends Light {
        constructor(skyColor?: number | string | Color, groundColor?: number | string | Color, intensity?: number);
    }
    export class PointLight extends Light {
        constructor(color?: number | string | Color, intensity?: number, distance?: number, decay?: number);
        position: Vector3;
    }

    // ----------------------------------------------------------------
    // Clock
    // ----------------------------------------------------------------

    export class Clock {
        constructor(autoStart?: boolean);
        autoStart: boolean;
        running: boolean;
        getDelta(): number;
        getElapsedTime(): number;
        start(): void;
        stop(): void;
    }

    // ----------------------------------------------------------------
    // Constants
    // ----------------------------------------------------------------

    export const FrontSide: number;
    export const BackSide: number;
    export const DoubleSide: number;

    export const NormalBlending: number;
    export const AdditiveBlending: number;
    export const SubtractiveBlending: number;

    export const StaticDrawUsage: number;
    export const DynamicDrawUsage: number;
    export const StreamDrawUsage: number;

    export const RepeatWrapping: number;
    export const ClampToEdgeWrapping: number;
    export const MirroredRepeatWrapping: number;

    export const LinearFilter: number;
    export const NearestFilter: number;
    export const LinearMipmapLinearFilter: number;

    export const RGBAFormat: number;
    export const RGBFormat: number;

    export const SRGBColorSpace: string;
    export const LinearSRGBColorSpace: string;
    export const NoColorSpace: string;

    export const REVISION: string;

    // ----------------------------------------------------------------
    // MOUSE / TOUCH — используются в OrbitControls
    // ----------------------------------------------------------------

    export enum MOUSE {
        LEFT = 0,
        MIDDLE = 1,
        RIGHT = 2,
        ROTATE = 0,
        DOLLY = 1,
        PAN = 2,
    }

    export enum TOUCH {
        ROTATE = 0,
        PAN = 1,
        DOLLY_PAN = 2,
        DOLLY_ROTATE = 3,
    }
}

// ====================================================================
// Fat lines (Line2 / LineMaterial и соответствующие geometry)
// ====================================================================

export class LineSegmentsGeometry {
    constructor();
    [key: string]: any;
    setPositions(array: number[] | Float32Array): this;
    setColors(array: number[] | Float32Array): this;
    computeLineDistances(): void;
    dispose(): void;
}

export class LineGeometry extends LineSegmentsGeometry {
    constructor();
}

export class LineMaterial extends THREE.Material {
    constructor(params?: {
        color?: number | string | THREE.Color;
        linewidth?: number;
        resolution?: THREE.Vector2;
        depthTest?: boolean;
        depthWrite?: boolean;
        transparent?: boolean;
        opacity?: number;
        dashed?: boolean;
        dashSize?: number;
        gapSize?: number;
        dashScale?: number;
        worldUnits?: boolean;
        alphaToCoverage?: boolean;
        [key: string]: any;
    });
    color: THREE.Color;
    linewidth: number;
    resolution: THREE.Vector2;
    dashed: boolean;
    dashSize: number;
    gapSize: number;
    dashScale: number;
    worldUnits: boolean;
}

export class Line2 extends THREE.Mesh {
    constructor(geometry?: LineGeometry | LineSegmentsGeometry, material?: LineMaterial);
    geometry: LineGeometry | LineSegmentsGeometry;
    material: LineMaterial;
    computeLineDistances(): this;
}

export class LineSegments2 extends Line2 {
    constructor(geometry?: LineSegmentsGeometry, material?: LineMaterial);
}

// ====================================================================
// OrbitControls
// ====================================================================

export interface OrbitControlsOptions {
    enableDamping?: boolean;
    dampingFactor?: number;
    enablePan?: boolean;
    panSpeed?: number;
    panLeft?: number;
    panUp?: number;
    panSpeedFactor?: number;
    enableRotate?: boolean;
    rotateSpeed?: number;
    enableZoom?: boolean;
    zoomSpeed?: number;
    zoomToCursor?: boolean;
    minDistance?: number;
    maxDistance?: number;
    minPolarAngle?: number;
    maxPolarAngle?: number;
    minAzimuthAngle?: number;
    maxAzimuthAngle?: number;
    screenSpacePanning?: boolean;
    mouseButtons?: Partial<Record<'LEFT' | 'MIDDLE' | 'RIGHT', number>>;
    touches?: Partial<Record<'ONE' | 'TWO', number>>;
    target?: THREE.Vector3;
    [key: string]: any;
}

export class OrbitControls {
    constructor(object: THREE.Camera, domElement?: HTMLElement);
    [key: string]: any;

    object: THREE.Camera;
    domElement: HTMLElement;

    enabled: boolean;
    enableDamping: boolean;
    dampingFactor: number;
    enablePan: boolean;
    enableRotate: boolean;
    enableZoom: boolean;
    zoomToCursor: boolean;

    target: THREE.Vector3;
    minDistance: number;
    maxDistance: number;
    minPolarAngle: number;
    maxPolarAngle: number;
    minAzimuthAngle: number;
    maxAzimuthAngle: number;

    screenSpacePanning: boolean;
    mouseButtons: Record<string, number>;
    touches: Record<string, number>;

    /** Внутренние поля, иногда используемые снаружи. */
    _cameraAnimation?: any;
    spherical?: any;
    sphericalDelta?: any;

    update(): boolean;
    saveState(): void;
    reset(): void;
    dispose(): void;
    listenToKeyEvents(el: HTMLElement): void;
    stopListenToKeyEvents(): void;
}

// ====================================================================
// Touch map controls (если tpb.js экспортирует свой объект-константу)
// ====================================================================

/**
 * Маппинг тач-жестов для OrbitControls, собранный в tpb.js.
 * Если у вас там другая форма (например, function, или другой
 * набор ключей) — поправьте этот тип. Здесь он дан как свободный
 * объект с известными ключами, которые точно используются.
 */
export const TOUCH_MAP_CONTROLS: {
    [key: string]: any;
    ONE?: number;
    TWO?: number;
    ROTATE?: number;
    PAN?: number;
    DOLLY_PAN?: number;
    DOLLY_ROTATE?: number;
};