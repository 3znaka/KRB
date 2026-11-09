// Diagram3D.ts
import { Marker3D } from './Marker3D.js';
import { THREE } from './js_TP/tpb.js';
import { getDiagram3DType, } from './Diagram3DTypes.js';
export class Diagram3D extends Marker3D {
    _typeName;
    _type;
    _data;
    _params;
    constructor(options) {
        const type = getDiagram3DType(options.type);
        const params = {
            data: options.data,
            unitM: options.unitM ?? 1,
            barWidthM: options.barWidthM,
            barDepthM: options.barDepthM,
            gapM: options.gapM,
            strokeColor: options.strokeColor,
            strokeWidthM: options.strokeWidthM,
            unitValue: options.unitValue,
            maxCols: options.maxCols,
        };
        super({
            ...options,
            primitiveType: 'box',
            size: null,
        });
        this._typeName = options.type;
        this._type = type;
        this._data = options.data;
        this._params = params;
    }
    _createPrimitive() {
        const group = this._type.build(this._params);
        const box = new THREE.Box3().setFromObject(group);
        const size = box.getSize(new THREE.Vector3());
        const min = box.min;
        const anchor = this.getAnchor();
        const anchorPoint = new THREE.Vector3(min.x + anchor[0] * size.x, min.y + anchor[1] * size.y, min.z + anchor[2] * size.z);
        // Смещаем внутренние объекты группы, а не саму группу
        group.children.forEach(child => {
            child.position.sub(anchorPoint);
        });
        // Корректируем локальный bbox для правильного рейкаста
        const localBox = box.clone().translate(anchorPoint.clone().negate());
        this._object3D = group;
        this._height = size.y;
        this._localBox = localBox;
        this._boundingRadius = 0.5 * size.length();
        this._boundingSphereOffset = localBox.getCenter(new THREE.Vector3());
        group.traverse((child) => {
            if (child.isMesh) {
                child.renderOrder = 10000;
            }
            if (child.isLineSegments) {
                child.renderOrder = 10001;
            }
        });
        this._raycastMeshesCache = null;
    }
    _getRaycastMeshes() {
        if (this._raycastMeshesCache)
            return this._raycastMeshesCache;
        const meshes = [];
        if (this._object3D) {
            this._object3D.traverse((child) => {
                if (child.isMesh)
                    meshes.push(child);
            });
        }
        this._raycastMeshesCache = meshes;
        return meshes;
    }
    _rebuildPrimitiveInPlace() {
        if (!this._object3D)
            return;
        const parent = this._object3D.parent;
        const oldPosition = this._object3D.position.clone();
        const oldRotation = this._object3D.rotation.clone();
        if (parent)
            parent.remove(this._object3D);
        this._object3D.traverse((child) => {
            if (child.isMesh) {
                child.geometry.dispose();
                if (Array.isArray(child.material))
                    child.material.forEach((m) => m.dispose());
                else
                    child.material.dispose();
            }
        });
        this._createPrimitive();
        if (this._object3D) {
            this._object3D.position.copy(oldPosition);
            this._object3D.rotation.copy(oldRotation);
            if (parent)
                parent.add(this._object3D);
        }
        this._raycastMeshesCache = null;
    }
    setData(data) {
        this._data = data;
        this._params.data = data;
        this._rebuildPrimitiveInPlace();
        return this;
    }
    setUnitM(m) {
        if (!(m > 0) || this._params.unitM === m)
            return this;
        this._params.unitM = m;
        this._rebuildPrimitiveInPlace();
        return this;
    }
}
