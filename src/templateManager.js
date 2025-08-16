import Template from "./Template";
import { base64ToUint8, numberToEncoded, colorpalette, blobToDataURL } from "./utils";

/** Manages the template system.
 * This class handles all external requests for template modification, creation, and analysis.
 * It serves as the central coordinator between template instances and the user interface.
 * @class TemplateManager
 * @since 0.55.8
 * @example
 * // JSON structure for a template
 * {
 *   "whoami": "BlueMarble",
 *   "scriptVersion": "1.13.0",
 *   "schemaVersion": "2.1.0",
 *   "templates": {
 *     "0 $Z": {
 *       "name": "My Template",
 *       "enabled": true,
 *       "tiles": {
 *         "1231,0047,183,593": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA",
 *         "1231,0048,183,000": "data:image/png;AAAFCAYAAACNbyblAAAAHElEQVQI12P4"
 *       }
 *     },
 *     "1 $Z": {
 *       "name": "My Template",
 *       "URL": "https://github.com/SwingTheVine/Wplace-BlueMarble/blob/main/dist/assets/Favicon.png",
 *       "URLType": "template",
 *       "enabled": false,
 *       "tiles": {
 *         "375,1846,276,188": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA",
 *         "376,1846,000,188": "data:image/png;AAAFCAYAAACNbyblAAAAHElEQVQI12P4"
 *       }
 *     }
 *   }
 * }
 */
export default class TemplateManager {

  /** The constructor for the {@link TemplateManager} class.
   * @since 0.55.8
   */
  constructor(name, version, overlay) {

    // Meta
    this.name = name; // Name of userscript
    this.version = version; // Version of userscript
    this.overlay = overlay; // The main instance of the Overlay class
    this.templatesVersion = '1.0.0'; // Version of JSON schema
    this.userID = null; // The ID of the current user
    this.encodingBase = '!#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~'; // Characters to use for encoding/decoding
    this.tileSize = 1000; // The number of pixels in a tile. Assumes the tile is square
    this.drawMult = 3; // The enlarged size for each pixel. E.g. when "3", a 1x1 pixel becomes a 1x1 pixel inside a 3x3 area. MUST BE ODD

    this.originalTileCache = new Map(); // Caches original tile blobs, Key: "tileX,tileY", Value: blob
    this.colorRGBLookup = new Map();    // Caches palette colors for fast reverse lookup, Key: "r,g,b", Value: colorIndex

    colorpalette.forEach((color, index) => {
      if (index === 0) return; // Skip transparent
      const key = color.rgb.join(',');
      this.colorRGBLookup.set(key, index);
    });

    // Template
    this.canvasTemplate = null; // Our canvas
    this.canvasTemplateZoomed = null; // The template when zoomed out
    this.canvasTemplateID = 'bm-canvas'; // Our canvas ID
    this.canvasMainID = 'div#map canvas.maplibregl-canvas'; // The selector for the main canvas
    this.template = null; // The template image.
    this.templateState = ''; // The state of the template ('blob', 'proccessing', 'template', etc.)
    this.templatesArray = []; // All Template instnaces currently loaded (Template)
    this.templatesJSON = null; // All templates currently loaded (JSON)
    this.templatesShouldBeDrawn = true; // Should ALL templates be drawn to the canvas?
  }

  /** Retrieves the pixel art canvas.
   * If the canvas has been updated/replaced, it retrieves the new one.
   * @param {string} selector - The CSS selector to use to find the canvas.
   * @returns {HTMLCanvasElement|null} The canvas as an HTML Canvas Element, or null if the canvas does not exist
   * @since 0.58.3
   * @deprecated Not in use since 0.63.25
   */
  /* @__PURE__ */getCanvas() {

    // If the stored canvas is "fresh", return the stored canvas
    if (document.body.contains(this.canvasTemplate)) { return this.canvasTemplate; }
    // Else, the stored canvas is "stale", get the canvas again

    // Attempt to find and destroy the "stale" canvas
    document.getElementById(this.canvasTemplateID)?.remove();

    const canvasMain = document.querySelector(this.canvasMainID);

    const canvasTemplateNew = document.createElement('canvas');
    canvasTemplateNew.id = this.canvasTemplateID;
    canvasTemplateNew.className = 'maplibregl-canvas';
    canvasTemplateNew.style.position = 'absolute';
    canvasTemplateNew.style.top = '0';
    canvasTemplateNew.style.left = '0';
    canvasTemplateNew.style.height = `${canvasMain?.clientHeight * (window.devicePixelRatio || 1)}px`;
    canvasTemplateNew.style.width = `${canvasMain?.clientWidth * (window.devicePixelRatio || 1)}px`;
    canvasTemplateNew.height = canvasMain?.clientHeight * (window.devicePixelRatio || 1);
    canvasTemplateNew.width = canvasMain?.clientWidth * (window.devicePixelRatio || 1);
    canvasTemplateNew.style.zIndex = '8999';
    canvasTemplateNew.style.pointerEvents = 'none';
    canvasMain?.parentElement?.appendChild(canvasTemplateNew); // Append the newCanvas as a child of the parent of the main canvas
    this.canvasTemplate = canvasTemplateNew; // Store the new canvas

    window.addEventListener('move', this.onMove);
    window.addEventListener('zoom', this.onZoom);
    window.addEventListener('resize', this.onResize);

    return this.canvasTemplate; // Return the new canvas
  }

  /** Creates the JSON object to store templates in
   * @returns {{ whoami: string, scriptVersion: string, schemaVersion: string, templates: Object }} The JSON object
   * @since 0.65.4
   */
  async createJSON() {
    return {
      "whoami": this.name.replace(' ', ''), // Name of userscript without spaces
      "scriptVersion": this.version, // Version of userscript
      "schemaVersion": this.templatesVersion, // Version of JSON schema
      "templates": {} // The templates
    };
  }

  /** Creates the template from the inputed file blob
   * @param {File} blob - The file blob to create a template from
   * @param {string} name - The display name of the template
   * @param {Array<number, number, number, number>} coords - The coordinates of the top left corner of the template
   * @since 0.65.77
   */
  async createTemplate(blob, name, coords) {
    if (!this.templatesJSON) {
      this.templatesJSON = await this.createJSON();
    }
    this.overlay.handleDisplayStatus(`Creating template at ${coords.join(', ')}...`);

    const template = new Template({
      displayName: name,
      sortID: 0,
      authorID: numberToEncoded(this.userID || 0, this.encodingBase),
      file: blob, // The raw file blob
      coords: coords
    });

    // This runs the processing to create chunked data AND rawPixelData
    const { templateTiles, templateTilesBuffers } = await template.createTemplateTiles();
    template.chunked = templateTiles;

    // --- NEW: Convert the original file blob to a Data URL for saving ---
    const templateDataURL = await blobToDataURL(blob);
    // --- END OF NEW ---

    this.templatesJSON.templates[`${template.sortID} ${template.authorID}`] = {
      "name": template.displayName,
      "coords": coords.join(', '),
      "enabled": true,
      "dataURL": templateDataURL, // <-- SAVE THE DATA URL
      "tiles": templateTilesBuffers
    };

    this.templatesArray = [template]; // Replace existing templates
    await this.#storeTemplates();

    const pixelCountFormatted = new Intl.NumberFormat().format(template.pixelCount);
    this.overlay.handleDisplayStatus(`Template created at ${coords.join(', ')}! Total pixels: ${pixelCountFormatted}`);
  }

  /** Generates a {@link Template} class instance from the JSON object template
   */
  #loadTemplate() {

  }

  /** Stores the JSON object of the loaded templates into TamperMonkey (GreaseMonkey) storage.
   * @since 0.72.7
   */
  async #storeTemplates() {
    GM.setValue('bmTemplates', JSON.stringify(this.templatesJSON));
  }

  /** Deletes a template from the JSON object.
   * Also delete's the corrosponding {@link Template} class instance
   */
  deleteTemplate() {

  }

  /** Disables the template from view
   */
  async disableTemplate() {

    // Creates the JSON object if it does not already exist
    if (!this.templatesJSON) { this.templatesJSON = await this.createJSON(); console.log(`Creating JSON...`); }


  }

  /** Draws all templates on the specified tile.
   * This method handles the rendering of template overlays on individual tiles.
   * @param {File} tileBlob - The pixels that are placed on a tile
   * @param {Array<number>} tileCoords - The tile coordinates [x, y]
   * @since 0.65.77
   */
  async drawTemplateOnTile(tileBlob, tileCoords) {
    // Cache the original tile blob for later analysis
    const tileKey = `${tileCoords[0].toString().padStart(4, '0')},${tileCoords[1].toString().padStart(4, '0')}`;
    this.originalTileCache.set(tileKey, tileBlob);
    // --- END OF ADDED BLOCK ---

    // Returns early if no templates should be drawn
    if (!this.templatesShouldBeDrawn) { return tileBlob; }

    // Returns early if no templates should be drawn
    if (!this.templatesShouldBeDrawn) { return tileBlob; }

    const drawSize = this.tileSize * this.drawMult; // Calculate draw multiplier for scaling

    // Format tile coordinates with proper padding for consistent lookup
    tileCoords = tileCoords[0].toString().padStart(4, '0') + ',' + tileCoords[1].toString().padStart(4, '0');

    console.log(`Searching for templates in tile: "${tileCoords}"`);

    const templateArray = this.templatesArray; // Stores a copy for sorting
    console.log(templateArray);

    // Sorts the array of Template class instances. 0 = first = lowest draw priority
    templateArray.sort((a, b) => { return a.sortID - b.sortID; });

    console.log(templateArray);

    // Retrieves the relavent template tile blobs
    const templatesToDraw = templateArray
      .map(template => {
        const matchingTiles = Object.keys(template.chunked).filter(tile =>
          tile.startsWith(tileCoords)
        );

        if (matchingTiles.length === 0) { return null; } // Return null when nothing is found

        // Retrieves the blobs of the templates for this tile
        const matchingTileBlobs = matchingTiles.map(tile => {

          const coords = tile.split(','); // [x, y, x, y] Tile/pixel coordinates

          return {
            bitmap: template.chunked[tile],
            tileCoords: [coords[0], coords[1]],
            pixelCoords: [coords[2], coords[3]]
          }
        });

        return matchingTileBlobs?.[0];
      })
      .filter(Boolean);

    console.log(templatesToDraw);

    const templateCount = templatesToDraw?.length || 0; // Number of templates to draw on this tile
    console.log(`templateCount = ${templateCount}`);

    if (templateCount > 0) {

      // Calculate total pixel count for templates actively being displayed in this tile
      const totalPixels = templateArray
        .filter(template => {
          // Filter templates to include only those with tiles matching current coordinates
          // This ensures we count pixels only for templates actually being rendered
          const matchingTiles = Object.keys(template.chunked).filter(tile =>
            tile.startsWith(tileCoords)
          );
          return matchingTiles.length > 0;
        })
        .reduce((sum, template) => sum + (template.pixelCount || 0), 0);

      // Format pixel count with locale-appropriate thousands separators for better readability
      // Examples: "1,234,567" (US), "1.234.567" (DE), "1 234 567" (FR)
      const pixelCountFormatted = new Intl.NumberFormat().format(totalPixels);

      // Display status information about the templates being rendered
      this.overlay.handleDisplayStatus(
        `Displaying ${templateCount} template${templateCount == 1 ? '' : 's'}.\nTotal pixels: ${pixelCountFormatted}`
      );
    } else {
      this.overlay.handleDisplayStatus(`Displaying ${templateCount} templates.`);
    }

    const tileBitmap = await createImageBitmap(tileBlob);

    const canvas = new OffscreenCanvas(drawSize, drawSize);
    const context = canvas.getContext('2d');

    context.imageSmoothingEnabled = false; // Nearest neighbor

    // Tells the canvas to ignore anything outside of this area
    context.beginPath();
    context.rect(0, 0, drawSize, drawSize);
    context.clip();

    context.clearRect(0, 0, drawSize, drawSize); // Draws transparent background
    context.drawImage(tileBitmap, 0, 0, drawSize, drawSize);

    // For each template in this tile, draw them.
    for (const template of templatesToDraw) {
      console.log(`Template:`);
      console.log(template);

      // Draws the each template on the tile based on it's relative position
      context.drawImage(template.bitmap, Number(template.pixelCoords[0]) * this.drawMult, Number(template.pixelCoords[1]) * this.drawMult);
    }

    return await canvas.convertToBlob({ type: 'image/png' });
  }

  /** Imports the JSON object, and appends it to any JSON object already loaded
   * @param {string} json - The JSON string to parse
   */
  async importJSON(json) {

    console.log(`Importing JSON...`);
    console.log(json);

    // If the passed in JSON is a Blue Marble template object...
    if (json?.whoami == 'BlueMarble') {
      await this.#parseBlueMarble(json); // ...parse the template object as Blue Marble
    }
  }

  /** Parses the Blue Marble JSON object
   * @param {string} json - The JSON string to parse
   * @since 0.72.13
   */
  async #parseBlueMarble(json) {
    console.log(`Parsing BlueMarble on page load...`);
    const templates = json.templates;

    if (Object.keys(templates).length === 0) return;

    for (const templateKey in templates) {
      if (!templates.hasOwnProperty(templateKey)) continue;

      const templateValue = templates[templateKey];

      // If there's no saved dataURL, we can't reconstruct the template for the auto-placer.
      // This supports older saved templates by still loading them visually.
      if (!templateValue.dataURL) {
        console.warn("Template found without dataURL. Visual overlay will work, but auto-placer must be re-initialized by creating a new template.");
        // You could add the old visual-only parsing logic here if needed.
        continue;
      }

      console.log("Reconstructing template from saved dataURL...");

      // Step 1: Convert the saved Base64 string back into a File-like Blob.
      const blobResponse = await fetch(templateValue.dataURL);
      const blob = await blobResponse.blob();

      // Step 2: Get all other metadata.
      const templateKeyArray = templateKey.split(' ');
      const sortID = Number(templateKeyArray?.[0]);
      const authorID = templateKeyArray?.[1] || '0';
      const displayName = templateValue.name || `Template ${sortID || ''}`;
      const coords = templateValue.coords.split(',').map(Number);

      // Step 3: Create a new Template instance, passing the rehydrated blob.
      const template = new Template({
        displayName: displayName,
        sortID: sortID,
        authorID: authorID,
        file: blob, // Use the rehydrated file
        coords: coords
      });

      // Step 4: Run the SINGLE, definitive processing function.
      // This will correctly generate BOTH the visual `chunked` data AND the `rawPixelData`.
            const { templateTiles } = await template.createTemplateTiles(); // <-- Capture the returned object
      template.chunked = templateTiles; // <-- THE MISSING LINE: Assign it to the instance property

      // Step 5: Add the fully reconstructed template to the active array.
      this.templatesArray.push(template);
      console.log(`Template "${displayName}" fully reconstructed and ready for auto-placer.`);
    }
  }

  updateUIFromLoadedTemplate() {
    if (this.templatesArray.length === 0) return;

    // Get the first loaded template
    const template = this.templatesArray[0];
    const coords = template.coords;

    if (coords && coords.length === 4) {
      console.log("Populating coordinate inputs from loaded template.", coords);
      this.overlay.updateInnerHTML('bm-input-tx', coords[0]);
      this.overlay.updateInnerHTML('bm-input-ty', coords[1]);
      this.overlay.updateInnerHTML('bm-input-px', coords[2]);
      this.overlay.updateInnerHTML('bm-input-py', coords[3]);
    }
  }

  /**
 * @param {number} tileX - The X coordinate of the tile to analyze.
 * @param {number} tileY - The Y coordinate of the tile to analyze.
 */
// src-new/templateManager.js -> In the TemplateManager class

  async initAutoPlacerForTile(tileX, tileY) { // <-- RENAMED
    this.overlay.handleDisplayStatus("Analyzing tile (1:1)...");

    const tileKey = `${tileX.toString().padStart(4, '0')},${tileY.toString().padStart(4, '0')}`;
    const originalTileBlob = this.originalTileCache.get(tileKey);

    if (!originalTileBlob) {
      this.overlay.handleDisplayError(`Original tile for ${tileX},${tileY} not in cache. Please view the tile first.`);
      return;
    }

    const template = this.templatesArray[0];
    if (!template || !template.rawPixelData) {
      this.overlay.handleDisplayError("No active template or raw pixel data found.");
      return;
    }

    try {
      // Step 1 & 2: Get pixel data and generate the initial queue of differences (unchanged)
      const originalBitmap = await createImageBitmap(originalTileBlob);
      const originalCanvas = new OffscreenCanvas(originalBitmap.width, originalBitmap.height);
      const originalCtx = originalCanvas.getContext('2d', { willReadFrequently: true });
      originalCtx.drawImage(originalBitmap, 0, 0);
      const originalImageData = originalCtx.getImageData(0, 0, originalBitmap.width, originalBitmap.height).data;

      const templateData = template.rawPixelData;
      const templateWidth = templateData.width;
      const templateHeight = templateData.height;

      const templateStartTileX = template.coords[0];
      const templateStartTileY = template.coords[1];
      const templateStartPixelX = template.coords[2];
      const templateStartPixelY = template.coords[3];
      
      let pixelQueue = [];

      for (let y = 0; y < templateHeight; y++) {
        for (let x = 0; x < templateWidth; x++) {
          const templateIndex = (y * templateWidth + x) * 4;
          if (templateData.data[templateIndex + 3] < 250) continue;

          const absolutePixelX = (templateStartTileX * this.tileSize) + templateStartPixelX + x;
          const absolutePixelY = (templateStartTileY * this.tileSize) + templateStartPixelY + y;
          const currentTileStartX = tileX * this.tileSize;
          const currentTileStartY = tileY * this.tileSize;

          if (
            absolutePixelX >= currentTileStartX && absolutePixelX < (currentTileStartX + this.tileSize) &&
            absolutePixelY >= currentTileStartY && absolutePixelY < (currentTileStartY + this.tileSize)
          ) {
            const pixelXOnTile = absolutePixelX % this.tileSize;
            const pixelYOnTile = absolutePixelY % this.tileSize;
            const originalIndex = (pixelYOnTile * this.tileSize + pixelXOnTile) * 4;

            const templateR = templateData.data[templateIndex];
            const templateG = templateData.data[templateIndex + 1];
            const templateB = templateData.data[templateIndex + 2];
            const originalR = originalImageData[originalIndex];
            const originalG = originalImageData[originalIndex + 1];
            const originalB = originalImageData[originalIndex + 2];
            const originalA = originalImageData[originalIndex + 3];

            if (originalA < 250 || templateR !== originalR || templateG !== originalG || templateB !== originalB) {
              const rgbKey = `${templateR},${templateG},${templateB}`;
              const colorIndex = this.colorRGBLookup.get(rgbKey);
              if (colorIndex !== undefined) {
                // We still need the template-relative coordinates for sorting
                pixelQueue.push({
                  pixelX: pixelXOnTile,
                  pixelY: pixelYOnTile,
                  templateX: x,
                  templateY: y,
                  colorIndex: colorIndex
                });
              }
            }
          }
        }
      }

      // --- NEW FEATURE: Sort the queue in a rectangular spiral (outside-in) ---
      if (pixelQueue.length > 1) {
          console.log(`Sorting queue of ${pixelQueue.length} pixels into rectangular spiral order...`);
          
          const sortedQueue = [];
          
          // Create a 2D grid representation of the pixels that need to be placed
          const pixelMap = new Map();
          pixelQueue.forEach(p => {
              if (!pixelMap.has(p.templateY)) pixelMap.set(p.templateY, new Map());
              pixelMap.get(p.templateY).set(p.templateX, p);
          });

          // Define the boundaries of the template
          let top = 0, bottom = templateHeight - 1;
          let left = 0, right = templateWidth - 1;
          
          while (top <= bottom && left <= right) {
              // 1. Traverse from left to right along the top row
              for (let i = left; i <= right; i++) {
                  if (pixelMap.get(top)?.has(i)) sortedQueue.push(pixelMap.get(top).get(i));
              }
              top++;

              // 2. Traverse from top to bottom along the right column
              for (let i = top; i <= bottom; i++) {
                  if (pixelMap.get(i)?.has(right)) sortedQueue.push(pixelMap.get(i).get(right));
              }
              right--;

              if (top <= bottom) {
                  // 3. Traverse from right to left along the bottom row
                  for (let i = right; i >= left; i--) {
                      if (pixelMap.get(bottom)?.has(i)) sortedQueue.push(pixelMap.get(bottom).get(i));
                  }
                  bottom--;
              }

              if (left <= right) {
                  // 4. Traverse from bottom to top along the left column
                  for (let i = bottom; i >= top; i--) {
                      if (pixelMap.get(i)?.has(left)) sortedQueue.push(pixelMap.get(i).get(left));
                  }
                  left++;
              }
          }
          pixelQueue = sortedQueue;
      }
      // --- END OF NEW FEATURE ---

      // Finalize the queue
      unsafeWindow.blueMarblePixelQueue = pixelQueue;
      const charges = this.overlay.apiManager.availableCharges;
      unsafeWindow.blueMarbleAvailableCharges = charges;
      const message = `Initialized with ${pixelQueue.length} pixels (rect-spiral order). Charges: ${charges.toFixed(1)}. Click 'Paint' to place.`; // <-- RENAMED
      this.overlay.handleDisplayStatus(message);
      console.log(message, unsafeWindow.blueMarblePixelQueue);

    } catch (error) {
      this.overlay.handleDisplayError("Failed to analyze pixels (1:1).");
      console.error("Error during 1:1 pixel analysis:", error);
    }
  }
  /** Parses the OSU! Place JSON object
   */
  #parseOSU() {

  }

  /** Sets the `templatesShouldBeDrawn` boolean to a value.
   * @param {boolean} value - The value to set the boolean to
   * @since 0.73.7
   */
  setTemplatesShouldBeDrawn(value) {
    this.templatesShouldBeDrawn = value;
  }
}
