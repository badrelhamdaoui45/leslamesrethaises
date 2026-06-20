const { Jimp } = require('jimp');
const path = require('path');
const fs = require('fs');

const coloredSource = "C:\\Users\\badre\\.gemini\\antigravity-ide\\brain\\6ac0d410-2637-4a27-a3da-45aae71e9b3a\\colored_logo_1781719344596.png";
const whiteSource = "C:\\Users\\badre\\.gemini\\antigravity-ide\\brain\\6ac0d410-2637-4a27-a3da-45aae71e9b3a\\white_logo_1781719357078.png";
const faviconSource = "C:\\Users\\badre\\.gemini\\antigravity-ide\\brain\\6ac0d410-2637-4a27-a3da-45aae71e9b3a\\favicon_logo_1781719485467.png";

const outputDir = "c:\\Users\\badre\\Desktop\\httpswww.federation-apcp.org";

// Queue-based flood fill to make background transparent
function makeBackgroundTransparent(image, isBgFn) {
  const w = image.width;
  const h = image.height;
  const queue = [];
  const visited = new Set();
  
  function enqueue(x, y) {
    const key = `${x},${y}`;
    if (x >= 0 && x < w && y >= 0 && y < h && !visited.has(key)) {
      visited.add(key);
      const idx = (y * w + x) * 4;
      const r = image.bitmap.data[idx];
      const g = image.bitmap.data[idx + 1];
      const b = image.bitmap.data[idx + 2];
      if (isBgFn(r, g, b)) {
        queue.push([x, y]);
        // Set alpha to 0 (transparent)
        image.bitmap.data[idx + 3] = 0;
      }
    }
  }
  
  // Start flood fill from borders
  for (let x = 0; x < w; x++) {
    enqueue(x, 0);
    enqueue(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    enqueue(0, y);
    enqueue(w - 1, y);
  }
  
  while (queue.length > 0) {
    const [cx, cy] = queue.shift();
    enqueue(cx + 1, cy);
    enqueue(cx - 1, cy);
    enqueue(cx, cy + 1);
    enqueue(cx, cy - 1);
  }
}

// Bounding box detection
function getBoundingBox(image) {
  const w = image.width;
  const h = image.height;
  let minX = w, maxX = 0, minY = h, maxY = 0;
  let hasPixels = false;
  
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const a = image.bitmap.data[idx + 3];
      if (a > 0) {
        hasPixels = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  
  if (!hasPixels) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

async function getCroppedLogo(sourcePath, isBgFn) {
  console.log(`Processing source image: ${sourcePath}`);
  const image = await Jimp.read(sourcePath);
  
  makeBackgroundTransparent(image, isBgFn);
  
  const box = getBoundingBox(image);
  if (!box) {
    throw new Error(`Failed to find bounding box in ${sourcePath}`);
  }
  
  console.log(`Cropped bounding box: x=${box.x}, y=${box.y}, w=${box.w}, h=${box.h}`);
  image.crop({ x: box.x, y: box.y, w: box.w, h: box.h });
  return image;
}

async function saveResizedLogo(croppedImage, destPath, targetWidth, targetHeight, paddingFactor = 0.95) {
  console.log(`Resizing to ${targetWidth}x${targetHeight} and saving to: ${destPath}`);
  
  // Clone the cropped image
  const imgCopy = croppedImage.clone();
  
  // Scale to fit target dimensions
  imgCopy.scaleToFit({ w: Math.round(targetWidth * paddingFactor), h: Math.round(targetHeight * paddingFactor) });
  
  // Create transparent destination canvas
  const canvas = new Jimp({ width: targetWidth, height: targetHeight, color: 0x00000000 });
  
  // Center drawing coordinates
  const dx = Math.round((targetWidth - imgCopy.width) / 2);
  const dy = Math.round((targetHeight - imgCopy.height) / 2);
  
  canvas.composite(imgCopy, dx, dy);
  
  // Get PNG buffer
  const buffer = await canvas.getBuffer('image/png');
  
  // Write buffer to file
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buffer);
}

async function main() {
  // 1. Process Colored Logo
  const isColoredBg = (r, g, b) => r > 235 && g > 235 && b > 235;
  const croppedColored = await getCroppedLogo(coloredSource, isColoredBg);
  
  // 2. Process White Logo
  const isWhiteBg = (r, g, b) => r < 115 && g < 115 && b < 115;
  const croppedWhite = await getCroppedLogo(whiteSource, isWhiteBg);
  
  // 3. Process Favicon
  const isFaviconBg = (r, g, b) => r > 245 && g > 245 && b > 245;
  const croppedFavicon = await getCroppedLogo(faviconSource, isFaviconBg);
  
  // Destinations
  const vfDestDir = path.join(outputDir, "wp-content", "uploads", "2025", "10");
  const favDestDir = path.join(outputDir, "wp-content", "uploads", "2025", "11");
  
  // VF-Logo-APCP variants (colored)
  const vfVariants = [
    { name: "VF-Logo-APCP-scaled.png", w: 2048, h: 688 },
    { name: "VF-Logo-APCP-scaled.png.webp", w: 2048, h: 688 },
    { name: "VF-Logo-APCP-2048x688.png", w: 2048, h: 688 },
    { name: "VF-Logo-APCP-2048x688.png.webp", w: 2048, h: 688 },
    { name: "VF-Logo-APCP-1536x516.png", w: 1536, h: 516 },
    { name: "VF-Logo-APCP-1536x516.png.webp", w: 1536, h: 516 },
    { name: "VF-Logo-APCP-1024x344.png", w: 1024, h: 344 },
    { name: "VF-Logo-APCP-1024x344.png.webp", w: 1024, h: 344 },
    { name: "VF-Logo-APCP-768x258.png", w: 768, h: 258 },
    { name: "VF-Logo-APCP-768x258.png.webp", w: 768, h: 258 },
    { name: "VF-Logo-APCP-300x101.png", w: 300, h: 101 },
    { name: "VF-Logo-APCP-300x101.png.webp", w: 300, h: 101 },
    { name: "cropped-VF-Logo-APCP-sans-acronyme.png", w: 2316, h: 662 }
  ];
  
  for (const v of vfVariants) {
    await saveResizedLogo(croppedColored, path.join(vfDestDir, v.name), v.w, v.h);
  }
  
  // White-Logo-APCP variants (white)
  const whiteVariants = [
    { name: "Logo-blanc-APCP-2048x1294.png", w: 2048, h: 1294 },
    { name: "Logo-blanc-APCP-2048x1294.png.webp", w: 2048, h: 1294 },
    { name: "Logo-blanc-APCP-1536x971.png", w: 1536, h: 971 },
    { name: "Logo-blanc-APCP-1536x971.png.webp", w: 1536, h: 971 },
    { name: "Logo-blanc-APCP-1024x647.png", w: 1024, h: 647 },
    { name: "Logo-blanc-APCP-1024x647.png.webp", w: 1024, h: 647 },
    { name: "Logo-blanc-APCP-768x485.png", w: 768, h: 485 },
    { name: "Logo-blanc-APCP-768x485.png.webp", w: 768, h: 485 },
    { name: "Logo-blanc-APCP-300x190.png", w: 300, h: 190 },
    { name: "Logo-blanc-APCP-300x190.png.webp", w: 300, h: 190 }
  ];
  
  for (const v of whiteVariants) {
    await saveResizedLogo(croppedWhite, path.join(vfDestDir, v.name), v.w, v.h);
  }
  
  // Favicons
  const favVariants = [
    { name: "cropped-Untitled-design-3-32x32.png", w: 32, h: 32, p: 1.0 },
    { name: "cropped-Untitled-design-3-180x180.png", w: 180, h: 180, p: 1.0 },
    { name: "cropped-Untitled-design-3-192x192.png", w: 192, h: 192, p: 1.0 }
  ];
  
  for (const v of favVariants) {
    await saveResizedLogo(croppedFavicon, path.join(favDestDir, v.name), v.w, v.h, v.p);
  }
  
  console.log("All logos and favicons processed and resized successfully!");
}

main().catch(err => {
  console.error("Fatal error: ", err);
  process.exit(1);
});
