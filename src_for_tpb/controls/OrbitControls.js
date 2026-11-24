import {
    EventDispatcher,
    MOUSE,
    Quaternion,
    Spherical,
    TOUCH,
    Vector2,
    Vector3,
    Plane,
    Ray,
    MathUtils
} from 'three';

/**
 * KRB extension: touch-mode identifier for two-finger map-style gestures
 * (pinch / rotate / tilt, resolved dynamically per gesture).
 *
 * Replaces the previous hack of relying on `TOUCH.MAP_CONTROLS === undefined`,
 * which worked only by coincidence (`undefined === undefined` in a switch).
 * Consumers must set:
 *
 *     controls.touches.TWO = TOUCH_MAP_CONTROLS;
 *
 * instead of `THREE.TOUCH.MAP_CONTROLS` (which is not a real three.js constant).
 */
export const TOUCH_MAP_CONTROLS = 7;

const _changeEvent = { type: 'change' };
const _startEvent  = { type: 'start'  };
const _endEvent    = { type: 'end'    };
const _ray   = new Ray();
const _plane = new Plane();
const TILT_LIMIT = Math.cos( 70 * MathUtils.DEG2RAD );

class OrbitControls extends EventDispatcher {

    constructor( object, domElement ) {

        super();

        this.object = object;
        this.domElement = domElement;
        this.domElement.style.touchAction = 'none'; // disable touch scroll

        // Set to false to disable this control
        this.enabled = true;

        // "target" sets the location of focus, where the object orbits around
        this.target = new Vector3();

        // Sets the 3D cursor (similar to Blender), from which the maxTargetRadius takes effect
        this.cursor = new Vector3();

        // How far you can dolly in and out ( PerspectiveCamera only )
        this.minDistance = 0;
        this.maxDistance = Infinity;

        // How far you can zoom in and out ( OrthographicCamera only )
        this.minZoom = 0;
        this.maxZoom = Infinity;

        // Limit camera target within a spherical area around the cursor
        this.minTargetRadius = 0;
        this.maxTargetRadius = Infinity;

        // How far you can orbit vertically, upper and lower limits.
        // Range is 0 to Math.PI radians.
        this.minPolarAngle = 0;
        this.maxPolarAngle = Math.PI;

        // Horizontal orbit limits.
        this.minAzimuthAngle = - Infinity;
        this.maxAzimuthAngle = Infinity;

        // Damping (inertia)
        this.enableDamping = false;
        this.dampingFactor = 0.05;

        // Zoom
        this.enableZoom = true;
        this.zoomSpeed = 1.0;

        // Rotate
        this.enableRotate = true;
        this.rotateSpeed = 1.0;

        // Pan
        this.enablePan = true;
        this.panSpeed = 1.0;
        this.screenSpacePanning = true;
        this.keyPanSpeed = 7.0;
        this.zoomToCursor = false;

        // Auto-rotate
        this.autoRotate = false;
        this.autoRotateSpeed = 2.0;

        this.keys = { LEFT: 'ArrowLeft', UP: 'ArrowUp', RIGHT: 'ArrowRight', BOTTOM: 'ArrowDown' };

        this.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };

        // Defaults; KRB map overrides `touches.TWO` with `TOUCH_MAP_CONTROLS`.
        this.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };

        // for reset
        this.target0 = this.target.clone();
        this.position0 = this.object.position.clone();
        this.zoom0 = this.object.zoom;

        this._domElementKeyEvents = null;

        //
        // Public methods
        //

        this.getPolarAngle = function () {
            return spherical.phi;
        };

        this.getAzimuthalAngle = function () {
            return spherical.theta;
        };

        this.getDistance = function () {
            return this.object.position.distanceTo( this.target );
        };

        this.listenToKeyEvents = function ( domElement ) {
            domElement.addEventListener( 'keydown', onKeyDown );
            this._domElementKeyEvents = domElement;
        };

        this.stopListenToKeyEvents = function () {
            this._domElementKeyEvents.removeEventListener( 'keydown', onKeyDown );
            this._domElementKeyEvents = null;
        };

        this.saveState = function () {
            scope.target0.copy( scope.target );
            scope.position0.copy( scope.object.position );
            scope.zoom0 = scope.object.zoom;
        };

        this.reset = function () {
            scope.target.copy( scope.target0 );
            scope.object.position.copy( scope.position0 );
            scope.object.zoom = scope.zoom0;

            scope.object.updateProjectionMatrix();
            scope.dispatchEvent( _changeEvent );

            scope.update();

            state = STATE.NONE;
        };

        this.update = function () {

            const offset = new Vector3();

            // so camera.up is the orbit axis
            const quat = new Quaternion().setFromUnitVectors( object.up, new Vector3( 0, 1, 0 ) );
            const quatInverse = quat.clone().invert();

            const lastPosition = new Vector3();
            const lastQuaternion = new Quaternion();
            const lastTargetPosition = new Vector3();

            const twoPI = 2 * Math.PI;

            return function update( deltaTime = null ) {

                const position = scope.object.position;

                offset.copy( position ).sub( scope.target );
                offset.applyQuaternion( quat );

                spherical.setFromVector3( offset );

                if ( scope.autoRotate && state === STATE.NONE ) {
                    rotateLeft( getAutoRotationAngle( deltaTime ) );
                }

                if ( scope.enableDamping ) {
                    spherical.theta += sphericalDelta.theta * scope.dampingFactor;
                    spherical.phi   += sphericalDelta.phi   * scope.dampingFactor;
                } else {
                    spherical.theta += sphericalDelta.theta;
                    spherical.phi   += sphericalDelta.phi;
                }

                // restrict theta
                let min = scope.minAzimuthAngle;
                let max = scope.maxAzimuthAngle;

                if ( isFinite( min ) && isFinite( max ) ) {
                    if ( min < - Math.PI ) min += twoPI; else if ( min > Math.PI ) min -= twoPI;
                    if ( max < - Math.PI ) max += twoPI; else if ( max > Math.PI ) max -= twoPI;

                    if ( min <= max ) {
                        spherical.theta = Math.max( min, Math.min( max, spherical.theta ) );
                    } else {
                        spherical.theta = ( spherical.theta > ( min + max ) / 2 )
                            ? Math.max( min, spherical.theta )
                            : Math.min( max, spherical.theta );
                    }
                }

                // restrict phi
                spherical.phi = Math.max( scope.minPolarAngle, Math.min( scope.maxPolarAngle, spherical.phi ) );
                spherical.makeSafe();

                // move target to panned location
                if ( scope.enableDamping === true ) {
                    scope.target.addScaledVector( panOffset, scope.dampingFactor );
                } else {
                    scope.target.add( panOffset );
                }

                // Limit target within cursor radius
                scope.target.sub( scope.cursor );
                scope.target.clampLength( scope.minTargetRadius, scope.maxTargetRadius );
                scope.target.add( scope.cursor );

                if ( scope.zoomToCursor && performCursorZoom || scope.object.isOrthographicCamera ) {
                    spherical.radius = clampDistance( spherical.radius );
                } else {
                    spherical.radius = clampDistance( spherical.radius * scale );
                }

                offset.setFromSpherical( spherical );
                offset.applyQuaternion( quatInverse );

                position.copy( scope.target ).add( offset );
                scope.object.lookAt( scope.target );

                if ( scope.enableDamping === true ) {
                    sphericalDelta.theta *= ( 1 - scope.dampingFactor );
                    sphericalDelta.phi   *= ( 1 - scope.dampingFactor );
                    panOffset.multiplyScalar( 1 - scope.dampingFactor );
                } else {
                    sphericalDelta.set( 0, 0, 0 );
                    panOffset.set( 0, 0, 0 );
                }

                let zoomChanged = false;
                if ( scope.zoomToCursor && performCursorZoom ) {

                    let newRadius = null;

                    if ( scope.object.isPerspectiveCamera ) {

                        const prevRadius = offset.length();
                        newRadius = clampDistance( prevRadius * scale );

                        const radiusDelta = prevRadius - newRadius;
                        scope.object.position.addScaledVector( dollyDirection, radiusDelta );
                        scope.object.updateMatrixWorld();

                    } else if ( scope.object.isOrthographicCamera ) {

                        const mouseBefore = new Vector3( mouse.x, mouse.y, 0 );
                        mouseBefore.unproject( scope.object );

                        scope.object.zoom = Math.max( scope.minZoom, Math.min( scope.maxZoom, scope.object.zoom / scale ) );
                        scope.object.updateProjectionMatrix();
                        zoomChanged = true;

                        const mouseAfter = new Vector3( mouse.x, mouse.y, 0 );
                        mouseAfter.unproject( scope.object );

                        scope.object.position.sub( mouseAfter ).add( mouseBefore );
                        scope.object.updateMatrixWorld();

                        newRadius = offset.length();

                    } else {
                        console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - zoom to cursor disabled.' );
                        scope.zoomToCursor = false;
                    }

                    if ( newRadius !== null ) {
                        if ( this.screenSpacePanning ) {
                            scope.target.set( 0, 0, - 1 )
                                .transformDirection( scope.object.matrix )
                                .multiplyScalar( newRadius )
                                .add( scope.object.position );
                        } else {
                            _ray.origin.copy( scope.object.position );
                            _ray.direction.set( 0, 0, - 1 ).transformDirection( scope.object.matrix );

                            if ( Math.abs( scope.object.up.dot( _ray.direction ) ) < TILT_LIMIT ) {
                                object.lookAt( scope.target );
                            } else {
                                _plane.setFromNormalAndCoplanarPoint( scope.object.up, scope.target );
                                _ray.intersectPlane( _plane, scope.target );
                            }
                        }
                    }

                } else if ( scope.object.isOrthographicCamera ) {

                    scope.object.zoom = Math.max( scope.minZoom, Math.min( scope.maxZoom, scope.object.zoom / scale ) );
                    scope.object.updateProjectionMatrix();
                    zoomChanged = true;

                }

                scale = 1;
                performCursorZoom = false;

                if ( zoomChanged ||
                    lastPosition.distanceToSquared( scope.object.position ) > EPS ||
                    8 * ( 1 - lastQuaternion.dot( scope.object.quaternion ) ) > EPS ||
                    lastTargetPosition.distanceToSquared( scope.target ) > 0 ) {

                    scope.dispatchEvent( _changeEvent );

                    lastPosition.copy( scope.object.position );
                    lastQuaternion.copy( scope.object.quaternion );
                    lastTargetPosition.copy( scope.target );

                    return true;
                }

                return false;
            };

        }();

        this.dispose = function () {

            scope.domElement.removeEventListener( 'contextmenu', onContextMenu );

            scope.domElement.removeEventListener( 'pointerdown', onPointerDown );
            scope.domElement.removeEventListener( 'pointercancel', onPointerUp );
            scope.domElement.removeEventListener( 'wheel', onMouseWheel );

            scope.domElement.removeEventListener( 'pointermove', onPointerMove );
            scope.domElement.removeEventListener( 'pointerup', onPointerUp );

            if ( scope._domElementKeyEvents !== null ) {
                scope._domElementKeyEvents.removeEventListener( 'keydown', onKeyDown );
                scope._domElementKeyEvents = null;
            }
        };

        //
        // Internals
        //

        const scope = this;

        /**
         * KRB extension: transient state of an active two-finger map-style
         * gesture (dist / angle / center before and at previous frame, plus
         * the currently locked-in gesture type).
         *
         * @type {{startDist:number, startAngle:number, startCenterX:number,
         *         startCenterY:number, prevDist:number, prevAngle:number,
         *         prevCenterX:number, prevCenterY:number,
         *         activeGesture:string|null}|null}
         */
        let mapControlsState = null;

        const STATE = {
            NONE: - 1,
            ROTATE: 0,
            DOLLY: 1,
            PAN: 2,
            TOUCH_ROTATE: 3,
            TOUCH_PAN: 4,
            TOUCH_DOLLY_PAN: 5,
            TOUCH_DOLLY_ROTATE: 6,
            TOUCH_MAP_CONTROLS: 7
        };

        let state = STATE.NONE;

        const EPS = 0.000001;

        const spherical      = new Spherical();
        const sphericalDelta = new Spherical();

        let scale = 1;
        const panOffset = new Vector3();

        const rotateStart = new Vector2();
        const rotateEnd   = new Vector2();
        const rotateDelta = new Vector2();

        const panStart = new Vector2();
        const panEnd   = new Vector2();
        const panDelta = new Vector2();

        const dollyStart = new Vector2();
        const dollyEnd   = new Vector2();
        const dollyDelta = new Vector2();

        const dollyDirection = new Vector3();
        const mouse          = new Vector2();
        let performCursorZoom = false;

        const pointers = [];
        const pointerPositions = {};

        function getAutoRotationAngle( deltaTime ) {
            if ( deltaTime !== null ) {
                return ( 2 * Math.PI / 60 * scope.autoRotateSpeed ) * deltaTime;
            } else {
                return 2 * Math.PI / 60 / 60 * scope.autoRotateSpeed;
            }
        }

        function getZoomScale( delta ) {
            const normalized_delta = Math.abs( delta ) / ( 100 * ( window.devicePixelRatio | 0 ) );
            return Math.pow( 0.95, scope.zoomSpeed * normalized_delta );
        }

        function rotateLeft( angle ) {
            sphericalDelta.theta -= angle;
        }

        function rotateUp( angle ) {
            sphericalDelta.phi -= angle;
        }

        const panLeft = function () {
            const v = new Vector3();
            return function panLeft( distance, objectMatrix ) {
                v.setFromMatrixColumn( objectMatrix, 0 );
                v.multiplyScalar( - distance );
                panOffset.add( v );
            };
        }();

        const panUp = function () {
            const v = new Vector3();
            return function panUp( distance, objectMatrix ) {
                if ( scope.screenSpacePanning === true ) {
                    v.setFromMatrixColumn( objectMatrix, 1 );
                } else {
                    v.setFromMatrixColumn( objectMatrix, 0 );
                    v.crossVectors( scope.object.up, v );
                }
                v.multiplyScalar( distance );
                panOffset.add( v );
            };
        }();

        const pan = function () {
            const offset = new Vector3();
            return function pan( deltaX, deltaY ) {
                const element = scope.domElement;

                if ( scope.object.isPerspectiveCamera ) {
                    const position = scope.object.position;
                    offset.copy( position ).sub( scope.target );
                    let targetDistance = offset.length();
                    targetDistance *= Math.tan( ( scope.object.fov / 2 ) * Math.PI / 180.0 );

                    panLeft( 2 * deltaX * targetDistance / element.clientHeight, scope.object.matrix );
                    panUp(   2 * deltaY * targetDistance / element.clientHeight, scope.object.matrix );
                } else if ( scope.object.isOrthographicCamera ) {
                    panLeft( deltaX * ( scope.object.right - scope.object.left ) / scope.object.zoom / element.clientWidth,  scope.object.matrix );
                    panUp(   deltaY * ( scope.object.top   - scope.object.bottom ) / scope.object.zoom / element.clientHeight, scope.object.matrix );
                } else {
                    console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - pan disabled.' );
                    scope.enablePan = false;
                }
            };
        }();

        function dollyOut( dollyScale ) {
            if ( scope.object.isPerspectiveCamera || scope.object.isOrthographicCamera ) {
                scale /= dollyScale;
            } else {
                console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled.' );
                scope.enableZoom = false;
            }
        }

        function dollyIn( dollyScale ) {
            if ( scope.object.isPerspectiveCamera || scope.object.isOrthographicCamera ) {
                scale *= dollyScale;
            } else {
                console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled.' );
                scope.enableZoom = false;
            }
        }

        function updateZoomParameters( x, y ) {
            if ( ! scope.zoomToCursor ) return;

            performCursorZoom = true;

            const rect = scope.domElement.getBoundingClientRect();
            const dx = x - rect.left;
            const dy = y - rect.top;
            const w  = rect.width;
            const h  = rect.height;

            mouse.x = ( dx / w ) * 2 - 1;
            mouse.y = - ( dy / h ) * 2 + 1;

            dollyDirection.set( mouse.x, mouse.y, 1 ).unproject( scope.object ).sub( scope.object.position ).normalize();
        }

        function clampDistance( dist ) {
            return Math.max( scope.minDistance, Math.min( scope.maxDistance, dist ) );
        }

        //
        // Event callbacks
        //

        function handleMouseDownRotate( event ) {
            rotateStart.set( event.clientX, event.clientY );
        }

        function handleMouseDownDolly( event ) {
            updateZoomParameters( event.clientX, event.clientX );
            dollyStart.set( event.clientX, event.clientY );
        }

        function handleMouseDownPan( event ) {
            panStart.set( event.clientX, event.clientY );
        }

        function handleMouseMoveRotate( event ) {
            rotateEnd.set( event.clientX, event.clientY );
            rotateDelta.subVectors( rotateEnd, rotateStart ).multiplyScalar( scope.rotateSpeed );

            const element = scope.domElement;
            rotateLeft( 2 * Math.PI * rotateDelta.x / element.clientHeight );
            rotateUp(   2 * Math.PI * rotateDelta.y / element.clientHeight );

            rotateStart.copy( rotateEnd );
            scope.update();
        }

        function handleMouseMoveDolly( event ) {
            dollyEnd.set( event.clientX, event.clientY );
            dollyDelta.subVectors( dollyEnd, dollyStart );

            if ( dollyDelta.y > 0 ) {
                dollyOut( getZoomScale( dollyDelta.y ) );
            } else if ( dollyDelta.y < 0 ) {
                dollyIn( getZoomScale( dollyDelta.y ) );
            }

            dollyStart.copy( dollyEnd );
            scope.update();
        }

        function handleMouseMovePan( event ) {
            panEnd.set( event.clientX, event.clientY );
            panDelta.subVectors( panEnd, panStart ).multiplyScalar( scope.panSpeed );
            pan( panDelta.x, panDelta.y );
            panStart.copy( panEnd );
            scope.update();
        }

        function handleMouseWheel( event ) {
            updateZoomParameters( event.clientX, event.clientY );

            if ( event.deltaY < 0 ) {
                dollyIn( getZoomScale( event.deltaY ) );
            } else if ( event.deltaY > 0 ) {
                dollyOut( getZoomScale( event.deltaY ) );
            }

            scope.update();
        }

        function handleKeyDown( event ) {
            let needsUpdate = false;

            switch ( event.code ) {
                case scope.keys.UP:
                    if ( event.ctrlKey || event.metaKey || event.shiftKey ) {
                        rotateUp( 2 * Math.PI * scope.rotateSpeed / scope.domElement.clientHeight );
                    } else {
                        pan( 0, scope.keyPanSpeed );
                    }
                    needsUpdate = true;
                    break;

                case scope.keys.BOTTOM:
                    if ( event.ctrlKey || event.metaKey || event.shiftKey ) {
                        rotateUp( - 2 * Math.PI * scope.rotateSpeed / scope.domElement.clientHeight );
                    } else {
                        pan( 0, - scope.keyPanSpeed );
                    }
                    needsUpdate = true;
                    break;

                case scope.keys.LEFT:
                    if ( event.ctrlKey || event.metaKey || event.shiftKey ) {
                        rotateLeft( 2 * Math.PI * scope.rotateSpeed / scope.domElement.clientHeight );
                    } else {
                        pan( scope.keyPanSpeed, 0 );
                    }
                    needsUpdate = true;
                    break;

                case scope.keys.RIGHT:
                    if ( event.ctrlKey || event.metaKey || event.shiftKey ) {
                        rotateLeft( - 2 * Math.PI * scope.rotateSpeed / scope.domElement.clientHeight );
                    } else {
                        pan( - scope.keyPanSpeed, 0 );
                    }
                    needsUpdate = true;
                    break;
            }

            if ( needsUpdate ) {
                event.preventDefault();
                scope.update();
            }
        }

        //
        // KRB map-style two-finger gestures
        //

        /**
         * Normalise an angle difference into (-π, π].
         * Avoids jumps when the vector between two touch points crosses ±π.
         */
        function normalizeAngleDiff( angle ) {
            let a = angle;
            while ( a >  Math.PI ) a -= 2 * Math.PI;
            while ( a < -Math.PI ) a += 2 * Math.PI;
            return a;
        }

        /**
         * NOTE: currently unused at runtime (the equivalent logic is inlined
         * inside `handleTouchMoveMapControls`). Kept for reference / future
         * refactorings. esbuild will tree-shake them out of the bundle since
         * nothing references them.
         */
        function applyMapGestureFromStart( state_, gesture, currentDist, currentAngle, currentCenterX, currentCenterY ) {
            switch ( gesture ) {
                case 'zoom': {
                    const factor = currentDist / state_.startDist;
                    if ( factor > 0 && isFinite( factor ) ) {
                        dollyOut( factor );
                        updateZoomParameters( currentCenterX, currentCenterY );
                    }
                    break;
                }
                case 'rotate': {
                    const angleDiff = normalizeAngleDiff( currentAngle - state_.startAngle );
                    sphericalDelta.theta += angleDiff * scope.rotateSpeed;
                    break;
                }
                case 'tilt': {
                    const tiltAmount = 2 * Math.PI * ( state_.startCenterY - currentCenterY ) /
                                       scope.domElement.clientHeight * scope.rotateSpeed;
                    sphericalDelta.phi += tiltAmount;
                    break;
                }
            }
        }

        function applyMapGestureIncrement( state_, gesture, currentDist, currentAngle, currentCenterX, currentCenterY ) {
            switch ( gesture ) {
                case 'zoom': {
                    const factor = currentDist / state_.prevDist;
                    if ( factor > 0 && isFinite( factor ) ) {
                        dollyOut( factor );
                        updateZoomParameters( currentCenterX, currentCenterY );
                    }
                    break;
                }
                case 'rotate': {
                    const angleDiff = normalizeAngleDiff( currentAngle - state_.prevAngle );
                    sphericalDelta.theta += angleDiff * scope.rotateSpeed;
                    break;
                }
                case 'tilt': {
                    const tiltDeltaY = state_.prevCenterY - currentCenterY;
                    const tiltAmount = 2 * Math.PI * tiltDeltaY /
                                       scope.domElement.clientHeight * scope.rotateSpeed;
                    sphericalDelta.phi += tiltAmount;
                    break;
                }
            }
        }

        function handleTouchStartMapControls( /* event */ ) {
            if ( pointers.length < 2 ) return;

            const pos0 = pointerPositions[ pointers[ 0 ] ];
            const pos1 = pointerPositions[ pointers[ 1 ] ];

            const dx = pos1.x - pos0.x;
            const dy = pos1.y - pos0.y;
            const dist = Math.sqrt( dx * dx + dy * dy );
            const angle = Math.atan2( dy, dx );
            const centerX = ( pos0.x + pos1.x ) * 0.5;
            const centerY = ( pos0.y + pos1.y ) * 0.5;

            mapControlsState = {
                startDist: dist,
                startAngle: angle,
                startCenterX: centerX,
                startCenterY: centerY,
                prevDist: dist,
                prevAngle: angle,
                prevCenterX: centerX,
                prevCenterY: centerY,
                activeGesture: null
            };
        }

        function handleTouchMoveMapControls( /* event */ ) {
            if ( ! mapControlsState || pointers.length < 2 ) return;

            const state_ = mapControlsState;
            const pos0 = pointerPositions[ pointers[ 0 ] ];
            const pos1 = pointerPositions[ pointers[ 1 ] ];

            const dx = pos1.x - pos0.x;
            const dy = pos1.y - pos0.y;
            const currentDist = Math.sqrt( dx * dx + dy * dy );
            const currentAngle = Math.atan2( dy, dx );
            const currentCenterX = ( pos0.x + pos1.x ) * 0.5;
            const currentCenterY = ( pos0.y + pos1.y ) * 0.5;

            // Gesture not locked in yet — decide which one it is.
            if ( state_.activeGesture === null ) {
                const GESTURE_THRESHOLD_PX = 10;
                const DOMINANCE_RATIO = 1.5;

                const zoomSignal = Math.abs( currentDist - state_.startDist );

                const angleDiff = normalizeAngleDiff( currentAngle - state_.startAngle );
                const rotateSignalPx = Math.abs( angleDiff ) * state_.startDist * 0.5;
                const tiltSignal = Math.abs( currentCenterY - state_.startCenterY );
                const rotateTiltSignal = Math.max( rotateSignalPx, tiltSignal );

                const maxSignal = Math.max( zoomSignal, rotateTiltSignal );

                if ( maxSignal < GESTURE_THRESHOLD_PX ) {
                    state_.prevDist = currentDist;
                    state_.prevAngle = currentAngle;
                    state_.prevCenterX = currentCenterX;
                    state_.prevCenterY = currentCenterY;
                    return;
                }

                if ( zoomSignal > rotateTiltSignal * DOMINANCE_RATIO ) {
                    // ZOOM
                    state_.activeGesture = 'zoom';
                    const factor = currentDist / state_.startDist;
                    if ( factor > 0 && isFinite( factor ) ) {
                        dollyOut( factor );
                        updateZoomParameters( currentCenterX, currentCenterY );
                    }
                } else if ( rotateTiltSignal > zoomSignal * DOMINANCE_RATIO ) {
                    // ROTATE + TILT
                    state_.activeGesture = 'rotateTilt';
                    const angleDiff2 = normalizeAngleDiff( currentAngle - state_.startAngle );
                    sphericalDelta.theta += angleDiff2 * scope.rotateSpeed;

                    const tiltAmount = 2 * Math.PI * ( state_.startCenterY - currentCenterY ) /
                                       scope.domElement.clientHeight * scope.rotateSpeed;
                    sphericalDelta.phi += tiltAmount;
                } else {
                    // Ambiguous — wait for a clearer signal.
                    state_.prevDist = currentDist;
                    state_.prevAngle = currentAngle;
                    state_.prevCenterX = currentCenterX;
                    state_.prevCenterY = currentCenterY;
                    return;
                }
            } else if ( state_.activeGesture === 'zoom' ) {
                const factor = currentDist / state_.prevDist;
                if ( factor > 0 && isFinite( factor ) ) {
                    dollyOut( factor );
                    updateZoomParameters( currentCenterX, currentCenterY );
                }
            } else if ( state_.activeGesture === 'rotateTilt' ) {
                const angleDiff = normalizeAngleDiff( currentAngle - state_.prevAngle );
                sphericalDelta.theta += angleDiff * scope.rotateSpeed;

                const tiltDeltaY = state_.prevCenterY - currentCenterY;
                const tiltAmount = 2 * Math.PI * tiltDeltaY /
                                   scope.domElement.clientHeight * scope.rotateSpeed;
                sphericalDelta.phi += tiltAmount;
            }

            state_.prevDist = currentDist;
            state_.prevAngle = currentAngle;
            state_.prevCenterX = currentCenterX;
            state_.prevCenterY = currentCenterY;
        }

        //
        // Vanilla touch handlers
        //

        function handleTouchStartRotate( event ) {
            if ( pointers.length === 1 ) {
                rotateStart.set( event.pageX, event.pageY );
            } else {
                const position = getSecondPointerPosition( event );
                const x = 0.5 * ( event.pageX + position.x );
                const y = 0.5 * ( event.pageY + position.y );
                rotateStart.set( x, y );
            }
        }

        function handleTouchStartPan( event ) {
            if ( pointers.length === 1 ) {
                panStart.set( event.pageX, event.pageY );
            } else {
                const position = getSecondPointerPosition( event );
                const x = 0.5 * ( event.pageX + position.x );
                const y = 0.5 * ( event.pageY + position.y );
                panStart.set( x, y );
            }
        }

        function handleTouchStartDolly( event ) {
            const position = getSecondPointerPosition( event );
            const dx = event.pageX - position.x;
            const dy = event.pageY - position.y;
            const distance = Math.sqrt( dx * dx + dy * dy );
            dollyStart.set( 0, distance );
        }

        function handleTouchStartDollyPan( event ) {
            if ( scope.enableZoom ) handleTouchStartDolly( event );
            if ( scope.enablePan )  handleTouchStartPan( event );
        }

        function handleTouchStartDollyRotate( event ) {
            if ( scope.enableZoom )   handleTouchStartDolly( event );
            if ( scope.enableRotate ) handleTouchStartRotate( event );
        }

        function handleTouchMoveRotate( event ) {
            if ( pointers.length == 1 ) {
                rotateEnd.set( event.pageX, event.pageY );
            } else {
                const position = getSecondPointerPosition( event );
                const x = 0.5 * ( event.pageX + position.x );
                const y = 0.5 * ( event.pageY + position.y );
                rotateEnd.set( x, y );
            }

            rotateDelta.subVectors( rotateEnd, rotateStart ).multiplyScalar( scope.rotateSpeed );

            const element = scope.domElement;
            rotateLeft( 2 * Math.PI * rotateDelta.x / element.clientHeight );
            rotateUp(   2 * Math.PI * rotateDelta.y / element.clientHeight );

            rotateStart.copy( rotateEnd );
        }

        function handleTouchMovePan( event ) {
            if ( pointers.length === 1 ) {
                panEnd.set( event.pageX, event.pageY );
            } else {
                const position = getSecondPointerPosition( event );
                const x = 0.5 * ( event.pageX + position.x );
                const y = 0.5 * ( event.pageY + position.y );
                panEnd.set( x, y );
            }

            panDelta.subVectors( panEnd, panStart ).multiplyScalar( scope.panSpeed );
            pan( panDelta.x, panDelta.y );
            panStart.copy( panEnd );
        }

        function handleTouchMoveDolly( event ) {
            const position = getSecondPointerPosition( event );
            const dx = event.pageX - position.x;
            const dy = event.pageY - position.y;
            const distance = Math.sqrt( dx * dx + dy * dy );

            dollyEnd.set( 0, distance );
            dollyDelta.set( 0, Math.pow( dollyEnd.y / dollyStart.y, scope.zoomSpeed ) );

            dollyOut( dollyDelta.y );
            dollyStart.copy( dollyEnd );

            const centerX = ( event.pageX + position.x ) * 0.5;
            const centerY = ( event.pageY + position.y ) * 0.5;
            updateZoomParameters( centerX, centerY );
        }

        function handleTouchMoveDollyPan( event ) {
            if ( scope.enableZoom ) handleTouchMoveDolly( event );
            if ( scope.enablePan )  handleTouchMovePan( event );
        }

        function handleTouchMoveDollyRotate( event ) {
            if ( scope.enableZoom )   handleTouchMoveDolly( event );
            if ( scope.enableRotate ) handleTouchMoveRotate( event );
        }

        //
        // Pointer / mouse / touch dispatch
        //

        function onPointerDown( event ) {
            if ( scope.enabled === false ) return;

            if ( pointers.length === 0 ) {
                scope.domElement.setPointerCapture( event.pointerId );
                scope.domElement.addEventListener( 'pointermove', onPointerMove );
                scope.domElement.addEventListener( 'pointerup', onPointerUp );
            }

            addPointer( event );

            if ( event.pointerType === 'touch' ) {
                onTouchStart( event );
            } else {
                onMouseDown( event );
            }
        }

        function onPointerMove( event ) {
            if ( scope.enabled === false ) return;

            if ( event.pointerType === 'touch' ) {
                onTouchMove( event );
            } else {
                onMouseMove( event );
            }
        }

        function onPointerUp( event ) {
            removePointer( event );

            if ( pointers.length === 0 ) {
                scope.domElement.releasePointerCapture( event.pointerId );
                scope.domElement.removeEventListener( 'pointermove', onPointerMove );
                scope.domElement.removeEventListener( 'pointerup', onPointerUp );
            }

            // KRB: clear the two-finger gesture state on every pointerup.
            mapControlsState = null;

            scope.dispatchEvent( _endEvent );

            state = STATE.NONE;
        }

        function onMouseDown( event ) {
            let mouseAction;

            switch ( event.button ) {
                case 0: mouseAction = scope.mouseButtons.LEFT;   break;
                case 1: mouseAction = scope.mouseButtons.MIDDLE; break;
                case 2: mouseAction = scope.mouseButtons.RIGHT;  break;
                default: mouseAction = - 1;
            }

            switch ( mouseAction ) {
                case MOUSE.DOLLY:
                    if ( scope.enableZoom === false ) return;
                    handleMouseDownDolly( event );
                    state = STATE.DOLLY;
                    break;

                case MOUSE.ROTATE:
                    if ( event.ctrlKey || event.metaKey || event.shiftKey ) {
                        if ( scope.enablePan === false ) return;
                        handleMouseDownPan( event );
                        state = STATE.PAN;
                    } else {
                        if ( scope.enableRotate === false ) return;
                        handleMouseDownRotate( event );
                        state = STATE.ROTATE;
                    }
                    break;

                case MOUSE.PAN:
                    if ( event.ctrlKey || event.metaKey || event.shiftKey ) {
                        if ( scope.enableRotate === false ) return;
                        handleMouseDownRotate( event );
                        state = STATE.ROTATE;
                    } else {
                        if ( scope.enablePan === false ) return;
                        handleMouseDownPan( event );
                        state = STATE.PAN;
                    }
                    break;

                default:
                    state = STATE.NONE;
            }

            if ( state !== STATE.NONE ) {
                scope.dispatchEvent( _startEvent );
            }
        }

        function onMouseMove( event ) {
            switch ( state ) {
                case STATE.ROTATE:
                    if ( scope.enableRotate === false ) return;
                    handleMouseMoveRotate( event );
                    break;

                case STATE.DOLLY:
                    if ( scope.enableZoom === false ) return;
                    handleMouseMoveDolly( event );
                    break;

                case STATE.PAN:
                    if ( scope.enablePan === false ) return;
                    handleMouseMovePan( event );
                    break;
            }
        }

        function onMouseWheel( event ) {
            if ( scope.enabled === false || scope.enableZoom === false || state !== STATE.NONE ) return;

            event.preventDefault();

            scope.dispatchEvent( _startEvent );
            handleMouseWheel( event );
            scope.dispatchEvent( _endEvent );
        }

        function onKeyDown( event ) {
            if ( scope.enabled === false || scope.enablePan === false ) return;
            handleKeyDown( event );
        }

        function onTouchStart( event ) {
            trackPointer( event );

            switch ( pointers.length ) {

                case 1:
                    switch ( scope.touches.ONE ) {
                        case TOUCH.ROTATE:
                            if ( scope.enableRotate === false ) return;
                            handleTouchStartRotate( event );
                            state = STATE.TOUCH_ROTATE;
                            break;

                        case TOUCH.PAN:
                            if ( scope.enablePan === false ) return;
                            handleTouchStartPan( event );
                            state = STATE.TOUCH_PAN;
                            break;

                        default:
                            state = STATE.NONE;
                    }
                    break;

                case 2:
                    switch ( scope.touches.TWO ) {
                        case TOUCH.DOLLY_PAN:
                            if ( scope.enableZoom === false && scope.enablePan === false ) return;
                            handleTouchStartDollyPan( event );
                            state = STATE.TOUCH_DOLLY_PAN;
                            break;

                        case TOUCH.DOLLY_ROTATE:
                            if ( scope.enableZoom === false && scope.enableRotate === false ) return;
                            handleTouchStartDollyRotate( event );
                            state = STATE.TOUCH_DOLLY_ROTATE;
                            break;

                        case TOUCH_MAP_CONTROLS:
                            if ( scope.enableZoom === false && scope.enableRotate === false ) return;
                            handleTouchStartMapControls( event );
                            state = STATE.TOUCH_MAP_CONTROLS;
                            break;

                        default:
                            state = STATE.NONE;
                    }
                    break;

                default:
                    state = STATE.NONE;
            }

            if ( state !== STATE.NONE ) {
                scope.dispatchEvent( _startEvent );
            }
        }

        function onTouchMove( event ) {
            trackPointer( event );

            switch ( state ) {
                case STATE.TOUCH_ROTATE:
                    if ( scope.enableRotate === false ) return;
                    handleTouchMoveRotate( event );
                    scope.update();
                    break;

                case STATE.TOUCH_PAN:
                    if ( scope.enablePan === false ) return;
                    handleTouchMovePan( event );
                    scope.update();
                    break;

                case STATE.TOUCH_DOLLY_PAN:
                    if ( scope.enableZoom === false && scope.enablePan === false ) return;
                    handleTouchMoveDollyPan( event );
                    scope.update();
                    break;

                case STATE.TOUCH_DOLLY_ROTATE:
                    if ( scope.enableZoom === false && scope.enableRotate === false ) return;
                    handleTouchMoveDollyRotate( event );
                    scope.update();
                    break;

                case STATE.TOUCH_MAP_CONTROLS:
                    handleTouchMoveMapControls( event );
                    scope.update();
                    break;

                default:
                    state = STATE.NONE;
            }
        }

        function onContextMenu( event ) {
            if ( scope.enabled === false ) return;
            event.preventDefault();
        }

        function addPointer( event ) {
            pointers.push( event.pointerId );
        }

        function removePointer( event ) {
            delete pointerPositions[ event.pointerId ];

            for ( let i = 0; i < pointers.length; i ++ ) {
                if ( pointers[ i ] == event.pointerId ) {
                    pointers.splice( i, 1 );
                    return;
                }
            }
        }

        function trackPointer( event ) {
            let position = pointerPositions[ event.pointerId ];

            if ( position === undefined ) {
                position = new Vector2();
                pointerPositions[ event.pointerId ] = position;
            }

            position.set( event.pageX, event.pageY );
        }

        function getSecondPointerPosition( event ) {
            const pointerId = ( event.pointerId === pointers[ 0 ] ) ? pointers[ 1 ] : pointers[ 0 ];
            return pointerPositions[ pointerId ];
        }

        //

        scope.domElement.addEventListener( 'contextmenu', onContextMenu );

        scope.domElement.addEventListener( 'pointerdown', onPointerDown );
        scope.domElement.addEventListener( 'pointercancel', onPointerUp );
        scope.domElement.addEventListener( 'wheel', onMouseWheel, { passive: false } );

        this.update();
    }
}

export { OrbitControls };