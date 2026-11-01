// Sprite.ts
export interface SpriteFrame {
    x: number; y: number;
    width: number; height: number;
    pixelRatio: number;
    sdf: boolean;
}

interface ColorizedAtlasOptions {
    colors?: Record<string, string>;
    defaultColor?: string;
    circleRatio?: number;
    glyphRatio?: number;
    outputScale?: number;
}

export class Sprite {
    private _frames = new Map<string, SpriteFrame>();
    private _atlasW = 0;
    private _atlasH = 0;
    private _img: HTMLImageElement | null = null;
    readonly pngUrl: string;

    constructor(private jsonUrl: string, pngUrl?: string) {
        this.pngUrl = pngUrl ?? jsonUrl.replace(/\.json(\?.*)?$/, '.png$1');
    }

    async load(): Promise<void> {
        const [json, img] = await Promise.all([
            fetch(this.jsonUrl).then(r => r.json()),
            new Promise<HTMLImageElement>((res, rej) => {
                const i = new Image();
                i.crossOrigin = 'anonymous';
                i.onload = () => res(i);
                i.onerror = rej;
                i.src = this.pngUrl;
            }),
        ]);
        this._atlasW = img.naturalWidth;
        this._atlasH = img.naturalHeight;
        this._img = img;
        for (const [name, f] of Object.entries(json as Record<string, SpriteFrame>)) {
            this._frames.set(name, f);
        }
    }



    get(name: string): SpriteFrame | null {
        return this._frames.get(name) ?? null;
    }

    /** Размеры иконки в CSS-px (делим на pixelRatio). */
    cssSize(name: string): { w: number; h: number } | null {
        const f = this.get(name);
        if (!f) return null;
        return { w: f.width / f.pixelRatio, h: f.height / f.pixelRatio };
    }

 cssStyle(name, scale = 1, bgColor = null, circleScale = 1.15, glyphRatio = 0.85) {
        const f = this.get(name);
        if (!f) return null;
        const pr = f.pixelRatio;
        const w = (f.width / pr) * scale;
        const h = (f.height / pr) * scale;

        if (bgColor) {
            // Размеры цветного круга
            const baseSize = Math.max(w, h);
            const circleSize = Math.ceil(baseSize * circleScale); // 1.15 даст 25px вместо 29px
            
            // Иконка занимает glyphRatio от круга (0.85 = 85%)
            const iconSize = Math.floor(baseSize * glyphRatio); 
            const iconScale = iconSize / Math.max(f.width / pr, f.height / pr);
            
            const bgScale = scale * iconScale;
            const bgWidth = (this._atlasW / pr) * bgScale;
            const bgHeight = (this._atlasH / pr) * bgScale;
            
            const innerW = Math.round(w * iconScale);
            const innerH = Math.round(h * iconScale);

            return {
                width: `${circleSize}px`,
                height: `${circleSize}px`,
                borderRadius: '50%',
                backgroundColor: bgColor,
                boxShadow: '0 1px 2px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.2)',
                boxSizing: 'border-box',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                _inner: {
                    width: `${innerW}px`,
                    height: `${innerH}px`,
                    backgroundImage: `url("${this.pngUrl}")`,
                    backgroundPosition: `-${(f.x / pr) * bgScale}px -${(f.y / pr) * bgScale}px`,
                    backgroundSize: `${bgWidth}px ${bgHeight}px`,
                    backgroundRepeat: 'no-repeat',
                    overflow: 'hidden'
                }
            };
        }

        // Старое поведение (без фона)
        return {
            width: `${w}px`,
            height: `${h}px`,
            backgroundImage: `url("${this.pngUrl}")`,
            backgroundPosition: `-${(f.x / pr) * scale}px -${(f.y / pr) * scale}px`,
            backgroundSize: `${(this._atlasW / pr) * scale}px ${(this._atlasH / pr) * scale}px`,
            backgroundRepeat: 'no-repeat',
        };
    }
}