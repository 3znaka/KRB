// ── three.js core: только то, что реально используется ──────────
import {
  // math
  Vector2, Vector3, Vector4, Quaternion, Euler, Matrix4,
  Box3, Sphere, Plane, Frustum, Raycaster, Color,
  // core / scene graph
  BufferAttribute, BufferGeometry,
  Group, Scene, Mesh, Line, LineSegments,
  PerspectiveCamera, WebGLRenderer,
  AmbientLight, DirectionalLight,
  Clock, AnimationMixer,
  // geometries
  BoxGeometry, PlaneGeometry, SphereGeometry,
  ConeGeometry, CylinderGeometry, CircleGeometry, EdgesGeometry,
  // materials
  Material, MeshBasicMaterial, MeshStandardMaterial,
  MeshLambertMaterial, LineBasicMaterial,
  // textures
  Texture, CanvasTexture, DataTexture, TextureLoader,
  // constants
  AdditiveBlending, MultiplyBlending, NormalBlending, SubtractiveBlending,
  DoubleSide, FrontSide,
  LinearFilter, RepeatWrapping,
  RGBAFormat, SRGBColorSpace,
  MOUSE,
} from 'three';

// Сохраняем обратную совместимость `THREE.X`.
// Классы — те же ссылки, что и внутри three, `instanceof` работает.
export const THREE = {
  Vector2, Vector3, Vector4, Quaternion, Euler, Matrix4,
  Box3, Sphere, Plane, Frustum, Raycaster, Color,
  BufferAttribute, BufferGeometry,
  Group, Scene, Mesh, Line, LineSegments,
  PerspectiveCamera, WebGLRenderer,
  AmbientLight, DirectionalLight,
  Clock, AnimationMixer,
  BoxGeometry, PlaneGeometry, SphereGeometry,
  ConeGeometry, CylinderGeometry, CircleGeometry, EdgesGeometry,
  Material, MeshBasicMaterial, MeshStandardMaterial,
  MeshLambertMaterial, LineBasicMaterial,
  Texture, CanvasTexture, DataTexture, TextureLoader,
  AdditiveBlending, MultiplyBlending, NormalBlending, SubtractiveBlending,
  DoubleSide, FrontSide,
  LinearFilter, RepeatWrapping,
  RGBAFormat, SRGBColorSpace,
  MOUSE,
};

// ── Аддоны ──────────────────────────────────────────────────────
export { OrbitControls, TOUCH_MAP_CONTROLS } from './controls/OrbitControls.js';
export { Line2 }                from 'three/examples/jsm/lines/Line2.js';
export { LineMaterial }         from 'three/examples/jsm/lines/LineMaterial.js';
export { LineGeometry }         from 'three/examples/jsm/lines/LineGeometry.js';
export { LineSegments2 }        from 'three/examples/jsm/lines/LineSegments2.js';
export { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
export { VectorTile }           from '@mapbox/vector-tile';
export { default as Protobuf }  from 'pbf';
export { GLTFLoader }           from 'three/examples/jsm/loaders/GLTFLoader.js';
export { DRACOLoader }          from 'three/examples/jsm/loaders/DRACOLoader.js';
export { GLTFExporter }         from 'three/examples/jsm/exporters/GLTFExporter.js';