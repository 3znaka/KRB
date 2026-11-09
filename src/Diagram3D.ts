// Diagram3D.ts
import { Marker3D, type Marker3DOptions } from './Marker3D.js';
import { THREE } from './js_TP/tpb.js';
import {
    type Diagram3DData, type Diagram3DRenderParams, type Diagram3DTypeDefinition,
    getDiagram3DType,
} from './Diagram3DTypes.js';
import type { PrimitiveType } from './Marker3D.js';


export interface Diagram3DOptions extends Omit<Marker3DOptions, 'primitiveType' | 'size' | 'modelUrl'> {
    type: string;
    data: Diagram3DData[];
    unitM?: number;
    barWidthM?: number;
    barDepthM?: number;
    gapM?: number;
    strokeColor?: string | number;
    strokeWidthM?: number;
    unitValue?: number;
    maxCols?: number;   
    primitiveType?: PrimitiveType; 
}

export type Diagram3DSpawnOptions = Omit<Diagram3DOptions, 'position' | 'crs'>;

export class Diagram3D extends Marker3D {
    private _typeName: string;
    private _type: Diagram3DTypeDefinition;
    private _data: Diagram3DData[];
    private _params: Diagram3DRenderParams;

    constructor(options: Diagram3DOptions) {
        const type = getDiagram3DType(options.type);
       const params: Diagram3DRenderParams = {
    data: options.data,
    unitM: options.unitM ?? 1,
    barWidthM: options.barWidthM,
    barDepthM: options.barDepthM,
    gapM: options.gapM,
    strokeColor: options.strokeColor,
    strokeWidthM: options.strokeWidthM,
    unitValue: options.unitValue, 
    maxCols: options.maxCols,     
    primitiveType: options.primitiveType,
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

    protected override _createPrimitive(): void {
        const group = this._type.build(this._params);
        
        const box = new THREE.Box3().setFromObject(group);
        const size = box.getSize(new THREE.Vector3());
        const min = box.min;
        
        const anchor = this.getAnchor();
        const anchorPoint = new THREE.Vector3(
            min.x + anchor[0] * size.x,
            min.y + anchor[1] * size.y,
            min.z + anchor[2] * size.z
        );
        
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
        
        group.traverse((child: any) => {
            if (child.isMesh) {
                child.renderOrder = 10000; 
            }
            if (child.isLineSegments) {
                child.renderOrder = 10001; 
            }
        });
        
        this._raycastMeshesCache = null;
    }

    protected override _getRaycastMeshes(): any[] {
        if (this._raycastMeshesCache) return this._raycastMeshesCache;
        const meshes: any[] = [];
        if (this._object3D) {
            this._object3D.traverse((child: any) => {
                if (child.isMesh) meshes.push(child);
            });
        }
        this._raycastMeshesCache = meshes;
        return meshes;
    }

    protected override _rebuildPrimitiveInPlace(): void {
        if (!this._object3D) return;
        const parent = this._object3D.parent;
        const oldPosition = this._object3D.position.clone();
        const oldRotation = this._object3D.rotation.clone();

        if (parent) parent.remove(this._object3D);
        
        this._object3D.traverse((child: any) => {
            if (child.isMesh) {
                child.geometry.dispose();
                if (Array.isArray(child.material)) child.material.forEach((m: any) => m.dispose());
                else child.material.dispose();
            }
        });

        this._createPrimitive();
        
        if (this._object3D) {
            this._object3D.position.copy(oldPosition);
            this._object3D.rotation.copy(oldRotation);
            if (parent) parent.add(this._object3D);
        }
        
        this._raycastMeshesCache = null;
    }

    setData(data: Diagram3DData[]): this {
        this._data = data;
        this._params.data = data;
        this._rebuildPrimitiveInPlace();
        return this;
    }
    
    setUnitM(m: number): this {
        if (!(m > 0) || this._params.unitM === m) return this;
        this._params.unitM = m;
        this._rebuildPrimitiveInPlace();
        return this;
    }
}