/** @file The main file. Everything in the userscript is executed from here.
 * @since 0.0.0
 */

import Overlay from './Overlay.js';
import Observers from './observers.js';
import ApiManager from './apiManager.js';
import TemplateManager from './templateManager.js';
import { consoleLog, consoleWarn } from './utils.js';

const name = GM_info.script.name.toString(); // Name of userscript
const version = GM_info.script.version.toString(); // Version of userscript
const consoleStyle = 'color: cornflowerblue;'; // The styling for the console logs

/** Injects code into the client
 * This code will execute outside of TamperMonkey's sandbox
 * @param {*} callback - The code to execute
 * @since 0.11.15
 */
function inject(callback) {
  const script = document.createElement('script');
  script.setAttribute('bm-name', name); // Passes in the name value
  script.setAttribute('bm-cStyle', consoleStyle); // Passes in the console style value
  script.textContent = `(${callback})();`;
  document.documentElement?.appendChild(script);
  script.remove();
}

/** What code to execute instantly in the client (webpage) to spy on fetch calls.
 * This code will execute outside of TamperMonkey's sandbox.
 * @since 0.11.15
 */
inject(() => {

  const script = document.currentScript;
  const name = script?.getAttribute('bm-name') || 'Blue Marble';
  const consoleStyle = script?.getAttribute('bm-cStyle') || '';
  const fetchedBlobQueue = new Map();

  // This message listener for handling responses from the main script remains unchanged.
  window.addEventListener('message', (event) => {
    const { source, endpoint, blobID, blobData, blink } = event.data;

    // This logic is specifically for the image tile modification callback.
    if ((source === 'blue-marble') && !!blobID && !!blobData && !endpoint) {
      if (blink) { // Check if blink exists to be more specific
        const elapsed = Date.now() - blink;
        console.groupCollapsed(`%c${name}%c: ${fetchedBlobQueue.size} Recieved IMAGE message about blob "${blobID}"`, consoleStyle, '');
        console.log(`Blob fetch took %c${String(Math.floor(elapsed / 60000)).padStart(2, '0')}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, '0')}.${String(elapsed % 1000).padStart(3, '0')}%c MM:SS.mmm`, consoleStyle, '');
        console.log(fetchedBlobQueue);
        console.groupEnd();
      }

      const callback = fetchedBlobQueue.get(blobID);
      if (typeof callback === 'function') {
        callback(blobData);
      } else {
        // Using console.warn directly since consoleWarn isn't defined here.
        console.warn(`%c${name}%c: Attempted to retrieve a blob (%s) from queue, but the blobID was not a function! Skipping...`, consoleStyle, '', blobID);
      }
      fetchedBlobQueue.delete(blobID);
    }
  });

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {

    const url = args[0] instanceof Request ? args[0].url : args[0];
    const options = args[1] || {};

    if (
      url.includes('/pixel/') &&
      options.method === 'POST' &&
      window.blueMarblePixelQueue &&
      window.blueMarblePixelQueue.length > 0
    ) {
      console.log("%cBlue Marble: Intercepted placement request. Preparing to modify payload...", "color: orange; font-weight: bold;");

      const charges = window.blueMarbleAvailableCharges;

      if (charges < 1) {
        console.log("%cBlue Marble: Halting placement, 0 charges available.", "color: red;");
        return new Response(JSON.stringify({ error: "Blocked by Blue Marble: No charges." }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const newOptions = args[1] || {};
      const originalBody = JSON.parse(newOptions.body);

      const mainQueue = window.blueMarblePixelQueue;
      const batchSize = Math.min(mainQueue.length, charges);
      console.log(`  - Charges: ${charges}. Queue: ${mainQueue.length}. Placing batch of ${batchSize}.`);

      const batchToPlace = mainQueue.splice(0, batchSize);

      originalBody["colors"] = batchToPlace.map(p => p.colorIndex);
      originalBody["coords"] = batchToPlace.flatMap(p => [p.pixelX, p.pixelY]);

      newOptions.body = JSON.stringify(originalBody);
      window.blueMarblePixelQueue = mainQueue;

      console.log("%c  - Sending modified request.", "color: lightgreen;");
      console.log("  - New Payload:", originalBody);
    }

    const response = await originalFetch.apply(this, args);
    const cloned = response.clone();
    const endpointName = url || 'ignore'; // Use the url we already parsed.
    const contentType = cloned.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      console.log(`%c${name}%c: Sending JSON message about endpoint "${endpointName}"`, consoleStyle, '');
      cloned.json().then(jsonData => {
        window.postMessage({
          source: 'blue-marble',
          endpoint: endpointName,
          jsonData: jsonData
        }, '*');
      }).catch(err => {
        console.error(`%c${name}%c: Failed to parse JSON: `, consoleStyle, '', err);
      });

    } else if (contentType.includes('image/') && !endpointName.includes('openfreemap') && !endpointName.includes('maps')) {
      const blink = Date.now();
      const blob = await cloned.blob();

      console.log(`%c${name}%c: ${fetchedBlobQueue.size} Sending IMAGE message about endpoint "${endpointName}"`, consoleStyle, '');

      // This returns a new Promise that resolves with the modified blob,
      // effectively replacing the original response with the template-drawn one.
      return new Promise((resolve) => {
        const blobUUID = crypto.randomUUID();
        fetchedBlobQueue.set(blobUUID, (blobProcessed) => {
          resolve(new Response(blobProcessed, {
            headers: cloned.headers,
            status: cloned.status,
            statusText: cloned.statusText
          }));
          console.log(`%c${name}%c: ${fetchedBlobQueue.size} Processed blob "${blobUUID}"`, consoleStyle, '');
        });

        window.postMessage({
          source: 'blue-marble',
          endpoint: endpointName,
          blobID: blobUUID,
          blobData: blob,
          blink: blink
        });
      }).catch(exception => {
        const elapsed = Date.now();
        console.error(`%c${name}%c: Failed to Promise blob!`, consoleStyle, '');
        console.groupCollapsed(`%c${name}%c: Details of failed blob Promise:`, consoleStyle, '');
        console.log(`Endpoint: ${endpointName}\nThere are ${fetchedBlobQueue.size} blobs processing...\nBlink: ${blink.toLocaleString()}\nTime Since Blink: ${String(Math.floor(elapsed / 60000)).padStart(2, '0')}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, '0')}.${String(elapsed % 1000).padStart(3, '0')} MM:SS.mmm`);
        console.error(`Exception stack:`, exception);
        console.groupEnd();
      });
    }

    return response;
  };
});

// Imports the CSS file from dist folder on github
const cssOverlay = GM_getResourceText("CSS-BM-File");
GM_addStyle(cssOverlay);

// Imports the Roboto Mono font family
var stylesheetLink = document.createElement('link');
stylesheetLink.href = 'https://fonts.googleapis.com/css2?family=Roboto+Mono:ital,wght@0,100..700;1,100..700&display=swap';
stylesheetLink.rel = 'preload';
stylesheetLink.as = 'style';
stylesheetLink.onload = function () {
  this.onload = null;
  this.rel = 'stylesheet';
};
document.head?.appendChild(stylesheetLink);

// CONSTRUCTORS
const observers = new Observers(); // Constructs a new Observers object
const overlayMain = new Overlay(name, version); // Constructs a new Overlay object for the main overlay
const overlayTabTemplate = new Overlay(name, version); // Constructs a Overlay object for the template tab
const templateManager = new TemplateManager(name, version, overlayMain); // Constructs a new TemplateManager object
const apiManager = new ApiManager(templateManager); // Constructs a new ApiManager object

overlayMain.setApiManager(apiManager); // Sets the API manager

(async () => {
    const storageTemplates = JSON.parse(GM_getValue('bmTemplates', '{}'));
    console.log(storageTemplates);

    // Now we WAIT for the entire import and reconstruction process to complete.
    await templateManager.importJSON(storageTemplates);
    templateManager.updateUIFromLoadedTemplate();
})();

buildOverlayMain(); // Builds the main overlay

overlayMain.handleDrag('#bm-overlay', '#bm-bar-drag'); // Creates dragging capability on the drag bar for dragging the overlay

apiManager.spontaneousResponseListener(overlayMain); // Reads spontaneous fetch responces

observeBlack(); // Observes the black palette color

consoleLog(`%c${name}%c (${version}) userscript has loaded!`, 'color: cornflowerblue;', '');

/** Observe the black color, and add the "Move" button.
 * @since 0.66.3
 */
function observeBlack() {
  const observer = new MutationObserver((mutations, observer) => {

    const black = document.querySelector('#color-1'); // Attempt to retrieve the black color element for anchoring

    if (!black) { return; } // Black color does not exist yet. Kills iteself

    let move = document.querySelector('#bm-button-move'); // Tries to find the move button

    // If the move button does not exist, we make a new one
    if (!move) {
      move = document.createElement('button');
      move.id = 'bm-button-move';
      move.textContent = 'Move ↑';
      move.className = 'btn btn-soft';
      move.onclick = function () {
        const roundedBox = this.parentNode.parentNode.parentNode.parentNode; // Obtains the rounded box
        const shouldMoveUp = (this.textContent == 'Move ↑');
        roundedBox.parentNode.className = roundedBox.parentNode.className.replace(shouldMoveUp ? 'bottom' : 'top', shouldMoveUp ? 'top' : 'bottom'); // Moves the rounded box to the top
        roundedBox.style.borderTopLeftRadius = shouldMoveUp ? '0px' : 'var(--radius-box)';
        roundedBox.style.borderTopRightRadius = shouldMoveUp ? '0px' : 'var(--radius-box)';
        roundedBox.style.borderBottomLeftRadius = shouldMoveUp ? 'var(--radius-box)' : '0px';
        roundedBox.style.borderBottomRightRadius = shouldMoveUp ? 'var(--radius-box)' : '0px';
        this.textContent = shouldMoveUp ? 'Move ↓' : 'Move ↑';
      }

      // Attempts to find the "Paint Pixel" element for anchoring
      const paintPixel = black.parentNode.parentNode.parentNode.parentNode.querySelector('h2');

      paintPixel.parentNode?.appendChild(move); // Adds the move button
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

/** Deploys the overlay to the page with minimize/maximize functionality.
 * Creates a responsive overlay UI that can toggle between full-featured and minimized states.
 * 
 * Parent/child relationships in the DOM structure below are indicated by indentation.
 * @since 0.58.3
 */
function buildOverlayMain() {
  let isMinimized = false; // Overlay state tracker (false = maximized, true = minimized)

  overlayMain.addDiv({ 'id': 'bm-overlay', 'style': 'top: 10px; right: 75px;' })
    .addDiv({ 'id': 'bm-contain-header' })
    .addDiv({ 'id': 'bm-bar-drag' }).buildElement()
    .addImg({ 'alt': 'Blue Marble Icon - Click to minimize/maximize', 'src': 'https://raw.githubusercontent.com/SwingTheVine/Wplace-BlueMarble/main/dist/assets/Favicon.png', 'style': 'cursor: pointer;' },
      (instance, img) => {
        /** Click event handler for overlay minimize/maximize functionality.
         * 
         * Toggles between two distinct UI states:
         * 1. MINIMIZED STATE (60×76px):
         *    - Shows only the Blue Marble icon and drag bar
         *    - Hides all input fields, buttons, and status information
         *    - Applies fixed dimensions for consistent appearance
         *    - Repositions icon with 3px right offset for visual centering
         * 
         * 2. MAXIMIZED STATE (responsive):
         *    - Restores full functionality with all UI elements
         *    - Removes fixed dimensions to allow responsive behavior
         *    - Resets icon positioning to default alignment
         *    - Shows success message when returning to maximized state
         * 
         * @param {Event} event - The click event object (implicit)
         */
        img.addEventListener('click', () => {
          isMinimized = !isMinimized; // Toggle the current state

          const overlay = document.querySelector('#bm-overlay');
          const header = document.querySelector('#bm-contain-header');
          const dragBar = document.querySelector('#bm-bar-drag');
          const coordsContainer = document.querySelector('#bm-contain-coords');
          const coordsButton = document.querySelector('#bm-button-coords');
          const createButton = document.querySelector('#bm-button-create');
          const enableButton = document.querySelector('#bm-button-enable');
          const disableButton = document.querySelector('#bm-button-disable');
          const coordInputs = document.querySelectorAll('#bm-contain-coords input');

          // Pre-restore original dimensions when switching to maximized state
          // This ensures smooth transition and prevents layout issues
          if (!isMinimized) {
            overlay.style.width = "auto";
            overlay.style.maxWidth = "300px";
            overlay.style.minWidth = "200px";
            overlay.style.padding = "10px";
          }

          // Define elements that should be hidden/shown during state transitions
          // Each element is documented with its purpose for maintainability
          const elementsToToggle = [
            '#bm-overlay h1',                    // Main title "Blue Marble"
            '#bm-contain-userinfo',              // User information section (username, droplets, level)
            '#bm-overlay hr',                    // Visual separator lines
            '#bm-contain-automation > *:not(#bm-contain-coords)', // Automation section excluding coordinates
            '#bm-input-file-template',           // Template file upload interface
            '#bm-contain-buttons-action',        // Action buttons container
            `#${instance.outputStatusId}`        // Status log textarea for user feedback
          ];

          // Apply visibility changes to all toggleable elements
          elementsToToggle.forEach(selector => {
            const elements = document.querySelectorAll(selector);
            elements.forEach(element => {
              element.style.display = isMinimized ? 'none' : '';
            });
          });
          // Handle coordinate container and button visibility based on state
          if (isMinimized) {
            // ==================== MINIMIZED STATE CONFIGURATION ====================
            // In minimized state, we hide ALL interactive elements except the icon and drag bar
            // This creates a clean, unobtrusive interface that maintains only essential functionality

            // Hide coordinate input container completely
            if (coordsContainer) {
              coordsContainer.style.display = 'none';
            }

            // Hide coordinate button (pin icon)
            if (coordsButton) {
              coordsButton.style.display = 'none';
            }

            // Hide create template button
            if (createButton) {
              createButton.style.display = 'none';
            }

            // Hide enable templates button
            if (enableButton) {
              enableButton.style.display = 'none';
            }

            // Hide disable templates button
            if (disableButton) {
              disableButton.style.display = 'none';
            }

            // Hide all coordinate input fields individually (failsafe)
            coordInputs.forEach(input => {
              input.style.display = 'none';
            });

            // Apply fixed dimensions for consistent minimized appearance
            // These dimensions were chosen to accommodate the icon while remaining compact
            overlay.style.width = '60px';    // Fixed width for consistency
            overlay.style.height = '76px';   // Fixed height (60px + 16px for better proportions)
            overlay.style.maxWidth = '60px';  // Prevent expansion
            overlay.style.minWidth = '60px';  // Prevent shrinking
            overlay.style.padding = '8px';    // Comfortable padding around icon

            // Apply icon positioning for better visual centering in minimized state
            // The 3px offset compensates for visual weight distribution
            img.style.marginLeft = '3px';

            // Configure header layout for minimized state
            header.style.textAlign = 'center';
            header.style.margin = '0';
            header.style.marginBottom = '0';

            // Ensure drag bar remains visible and properly spaced
            if (dragBar) {
              dragBar.style.display = '';
              dragBar.style.marginBottom = '0.25em';
            }
          } else {
            // ==================== MAXIMIZED STATE RESTORATION ====================
            // In maximized state, we restore all elements to their default functionality
            // This involves clearing all style overrides applied during minimization

            // Restore coordinate container to default state
            if (coordsContainer) {
              coordsContainer.style.display = '';           // Show container
              coordsContainer.style.flexDirection = '';     // Reset flex layout
              coordsContainer.style.justifyContent = '';    // Reset alignment
              coordsContainer.style.alignItems = '';        // Reset alignment
              coordsContainer.style.gap = '';               // Reset spacing
              coordsContainer.style.textAlign = '';         // Reset text alignment
              coordsContainer.style.margin = '';            // Reset margins
            }

            // Restore coordinate button visibility
            if (coordsButton) {
              coordsButton.style.display = '';
            }

            // Restore create button visibility and reset positioning
            if (createButton) {
              createButton.style.display = '';
              createButton.style.marginTop = '';
            }

            // Restore enable button visibility and reset positioning
            if (enableButton) {
              enableButton.style.display = '';
              enableButton.style.marginTop = '';
            }

            // Restore disable button visibility and reset positioning
            if (disableButton) {
              disableButton.style.display = '';
              disableButton.style.marginTop = '';
            }

            // Restore all coordinate input fields
            coordInputs.forEach(input => {
              input.style.display = '';
            });

            // Reset icon positioning to default (remove minimized state offset)
            img.style.marginLeft = '';

            // Restore overlay to responsive dimensions
            overlay.style.padding = '10px';

            // Reset header styling to defaults
            header.style.textAlign = '';
            header.style.margin = '';
            header.style.marginBottom = '';

            // Reset drag bar spacing
            if (dragBar) {
              dragBar.style.marginBottom = '0.5em';
            }

            // Remove all fixed dimensions to allow responsive behavior
            // This ensures the overlay can adapt to content changes
            overlay.style.width = '';
            overlay.style.height = '';
          }

          // ==================== ACCESSIBILITY AND USER FEEDBACK ====================
          // Update accessibility information for screen readers and tooltips

          // Update alt text to reflect current state for screen readers and tooltips
          img.alt = isMinimized ?
            'Blue Marble Icon - Minimized (Click to maximize)' :
            'Blue Marble Icon - Maximized (Click to minimize)';

          // No status message needed - state change is visually obvious to users
        });
      }
    ).buildElement()
    .addHeader(1, { 'textContent': name }).buildElement()
    .buildElement()

    .addHr().buildElement()

    .addDiv({ 'id': 'bm-contain-userinfo' })
    .addP({ 'id': 'bm-user-name', 'textContent': 'Username:' }).buildElement()
    .addP({ 'id': 'bm-user-droplets', 'textContent': 'Droplets:' }).buildElement()
    .addP({ 'id': 'bm-user-nextlevel', 'textContent': 'Next level in...' }).buildElement()
    .buildElement()

    .addHr().buildElement()

    .addDiv({ 'id': 'bm-contain-automation' })
    // .addCheckbox({'id': 'bm-input-stealth', 'textContent': 'Stealth', 'checked': true}).buildElement()
    // .addButtonHelp({'title': 'Waits for the website to make requests, instead of sending requests.'}).buildElement()
    // .addBr().buildElement()
    // .addCheckbox({'id': 'bm-input-possessed', 'textContent': 'Possessed', 'checked': true}).buildElement()
    // .addButtonHelp({'title': 'Controls the website as if it were possessed.'}).buildElement()
    // .addBr().buildElement()
    .addDiv({ 'id': 'bm-contain-coords' })
    .addButton({ 'id': 'bm-button-coords', 'className': 'bm-help', 'style': 'margin-top: 0;', 'innerHTML': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 6"><circle cx="2" cy="2" r="2"></circle><path d="M2 6 L3.7 3 L0.3 3 Z"></path><circle cx="2" cy="2" r="0.7" fill="white"></circle></svg></svg>' },
      (instance, button) => {
        button.onclick = () => {
          const coords = instance.apiManager?.coordsTilePixel; // Retrieves the coords from the API manager
          if (!coords?.[0]) {
            instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?');
            return;
          }
          instance.updateInnerHTML('bm-input-tx', coords?.[0] || '');
          instance.updateInnerHTML('bm-input-ty', coords?.[1] || '');
          instance.updateInnerHTML('bm-input-px', coords?.[2] || '');
          instance.updateInnerHTML('bm-input-py', coords?.[3] || '');
        }
      }
    ).buildElement()
    .addInput({ 'type': 'number', 'id': 'bm-input-tx', 'placeholder': 'Tl X', 'min': 0, 'max': 2047, 'step': 1, 'required': true }).buildElement()
    .addInput({ 'type': 'number', 'id': 'bm-input-ty', 'placeholder': 'Tl Y', 'min': 0, 'max': 2047, 'step': 1, 'required': true }).buildElement()
    .addInput({ 'type': 'number', 'id': 'bm-input-px', 'placeholder': 'Px X', 'min': 0, 'max': 2047, 'step': 1, 'required': true }).buildElement()
    .addInput({ 'type': 'number', 'id': 'bm-input-py', 'placeholder': 'Px Y', 'min': 0, 'max': 2047, 'step': 1, 'required': true }).buildElement()
    .buildElement()
    .addInputFile({ 'id': 'bm-input-file-template', 'textContent': 'Upload Template', 'accept': 'image/png, image/jpeg, image/webp, image/bmp, image/gif' }).buildElement()
    .addDiv({ 'id': 'bm-contain-buttons-template' })
    .addButton({ 'id': 'bm-button-enable', 'textContent': 'Enable' }, (instance, button) => {
      button.onclick = () => {
        instance.apiManager?.templateManager?.setTemplatesShouldBeDrawn(true);
        instance.handleDisplayStatus(`Enabled templates!`);
      }
    }).buildElement()
    .addButton({ 'id': 'bm-button-create', 'textContent': 'Create' }, (instance, button) => {
      button.onclick = () => {
        const input = document.querySelector('#bm-input-file-template');

        const coordTlX = document.querySelector('#bm-input-tx');
        if (!coordTlX.checkValidity()) { coordTlX.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return; }
        const coordTlY = document.querySelector('#bm-input-ty');
        if (!coordTlY.checkValidity()) { coordTlY.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return; }
        const coordPxX = document.querySelector('#bm-input-px');
        if (!coordPxX.checkValidity()) { coordPxX.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return; }
        const coordPxY = document.querySelector('#bm-input-py');
        if (!coordPxY.checkValidity()) { coordPxY.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return; }

        // Kills itself if there is no file
        if (!input?.files[0]) { instance.handleDisplayError(`No file selected!`); return; }

        templateManager.createTemplate(input.files[0], input.files[0]?.name.replace(/\.[^/.]+$/, ''), [Number(coordTlX.value), Number(coordTlY.value), Number(coordPxX.value), Number(coordPxY.value)]);

        // console.log(`TCoords: ${apiManager.templateCoordsTilePixel}\nCoords: ${apiManager.coordsTilePixel}`);
        // apiManager.templateCoordsTilePixel = apiManager.coordsTilePixel; // Update template coords
        // console.log(`TCoords: ${apiManager.templateCoordsTilePixel}\nCoords: ${apiManager.coordsTilePixel}`);
        // templateManager.setTemplateImage(input.files[0]);

        instance.handleDisplayStatus(`Drew to canvas!`);
      }
    }).buildElement()
    .addButton({ 'id': 'bm-button-disable', 'textContent': 'Disable' }, (instance, button) => {
      button.onclick = () => {
        instance.apiManager?.templateManager?.setTemplatesShouldBeDrawn(false);
        instance.handleDisplayStatus(`Disabled templates!`);
      }
    }).buildElement()
    .addButton({ 'id': 'bm-button-init-placer', 'textContent': 'Initialize Auto Place' },
      (instance, button) => {
        button.onclick = () => {
          // Get the current tile coordinates from the game state.
          // The script already saves the last clicked coordinates, we can use those.
          const coords = instance.apiManager?.coordsTilePixel;
          if (!coords || coords.length < 2) {
            instance.handleDisplayError('No tile coordinates found! Click on the canvas first.');
            return;
          }
          const currentTileX = coords[0];
          const currentTileY = coords[1];

          // Call the new analysis function with the current tile coordinates.
          instance.apiManager.templateManager.initAutoPlacerForTile(currentTileX, currentTileY);
        }
      }
    ).buildElement()
    .buildElement()
    .addTextarea({ 'id': overlayMain.outputStatusId, 'placeholder': `Status: Sleeping...\nVersion: ${version}`, 'readOnly': true }).buildElement()
    .addDiv({ 'id': 'bm-contain-buttons-action' })
    .addDiv()
    // .addButton({'id': 'bm-button-teleport', 'className': 'bm-help', 'textContent': '✈'}).buildElement()
    // .addButton({'id': 'bm-button-favorite', 'className': 'bm-help', 'innerHTML': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><polygon points="10,2 12,7.5 18,7.5 13.5,11.5 15.5,18 10,14 4.5,18 6.5,11.5 2,7.5 8,7.5" fill="white"></polygon></svg>'}).buildElement()
    // .addButton({'id': 'bm-button-templates', 'className': 'bm-help', 'innerHTML': '🖌'}).buildElement()
    .addButton({ 'id': 'bm-button-convert', 'className': 'bm-help', 'innerHTML': '🎨', 'title': 'Template Color Converter' },
      (instance, button) => {
        button.addEventListener('click', () => {
          window.open('https://pepoafonso.github.io/color_converter_wplace/', '_blank', 'noopener noreferrer');
        });
      }).buildElement()
    .buildElement()
    .addSmall({ 'textContent': 'Made by SwingTheVine', 'style': 'margin-top: auto;' }).buildElement()
    .buildElement()
    .buildElement()
    .buildOverlay(document.body);
}

function buildOverlayTabTemplate() {
  overlayTabTemplate.addDiv({ 'id': 'bm-tab-template', 'style': 'top: 20%; left: 10%;' })
    .addDiv()
    .addDiv({ 'className': 'bm-dragbar' }).buildElement()
    .addButton({ 'className': 'bm-button-minimize', 'textContent': '↑' },
      (instance, button) => {
        button.onclick = () => {
          let isMinimized = false;
          if (button.textContent == '↑') {
            button.textContent = '↓';
          } else {
            button.textContent = '↑';
            isMinimized = true;
          }


        }
      }
    ).buildElement()
    .buildElement()
    .buildElement()
    .buildOverlay();
}