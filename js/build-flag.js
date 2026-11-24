/**
 * Флаг сборки бандла.
 *
 * В обычной ESM-сборке значение — false. При сборке KRB.bundle.min.js
 * build.bundle.mjs заменяет строку `false /* __KRB_FLAG__ *\/` на `true`
 * (плагин bundle-flag). Так маркер не бывает неопределённым и не падает
 * с ReferenceError.
 */
export const IS_BUNDLE_BUILD = false /* __KRB_FLAG__ */;
