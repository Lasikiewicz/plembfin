const rasterPattern = /\.(?:png|jpe?g|webp)$/i;

export const responsiveImageWidths = Object.freeze([720, 1440]);

export function isOptimizableRasterPath(value) {
  return typeof value === "string"
    && value.startsWith("/assets/")
    && !value.startsWith("/assets/optimized/")
    && rasterPattern.test(value);
}

export function getImageVariantWidths(sourceWidth) {
  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0) return [...responsiveImageWidths];

  const width = Math.floor(sourceWidth);
  const variants = new Set(responsiveImageWidths.filter((candidate) => candidate < width));
  variants.add(Math.min(width, responsiveImageWidths.at(-1)));
  return [...variants].sort((left, right) => left - right);
}

export function getImageVariantPath(sourcePath, width, format) {
  if (!sourcePath) return sourcePath;
  const relativePath = sourcePath
    .replace(/^\/assets\//, "")
    .replace(/\.(?:png|jpe?g|webp)$/i, `-${width}.${format}`);
  return `/assets/optimized/${relativePath}`;
}
