import L from 'leaflet';
import 'leaflet-hash';
import 'leaflet/dist/leaflet.css';
import FileSaver from 'file-saver';

import AppUI from './AppUI.svelte';
import { displayOptions } from './displayOptions';
import { parseNumber } from './colorFunctions';
import { parseNestedObject } from './utils';

let query;
let layer;
let scene_config
let map, hash, tooltip, popup;

// grab query parameters from the url and assign them to globals
query = new URLSearchParams(document.location.search);

var url_hash = window.location.hash.slice(1, window.location.hash.length).split('/');
var mapStartLocation = null
if (url_hash.length == 3) {
  mapStartLocation = {
    lat: Number(url_hash[1]),
    lng: Number(url_hash[2]),
    zoom: Number(url_hash[0])
  };
}

map = L.map('map', { boxZoom: false, zoomControl: false });
hash = new L.Hash(map);
tooltip = L.tooltip();
popup = L.popup({ autoPan: false, closeButton: true });

// Leaflet needs an initial location before the map is "ready", which will block Tangram layer loading
map.setView([37.7,-122.4], 2);

// Initialize App UI
const appUI = new AppUI({
  target: document.getElementById('ui')
});

window.appUI = appUI; // debugging

// Handle UI events affecting Tangram scene
appUI.on('loadScene', state => {
  loadScene(state);
});

appUI.on('updateScene', state => {
  if (scene_config) {
    updateScene(state);
    scene.updateConfig();
  }
});

// Load info on a new XYZ space
appUI.on('loadSpace', ({ spaceId, token }) => {
  getStats({ spaceId, token, mapStartLocation });
});

// Handle query string updates
appUI.on('updateQueryString', ({ queryParams }) => {
  const query = new URLSearchParams(queryParams);
  const qs = `?${query.toString()}${window.location.hash}`;
  window.history.replaceState(null, null, qs);
});

// Initialize UI with query string params
appUI.setFromQueryParams(query);

// lookup value of a nested feature property
function lookupProperty(properties, propStack) {
  return propStack && propStack.reduce((obj, prop) => obj && obj[prop] !== undefined ? obj[prop] : null, properties);
}

// apply updates to scene based on current display options
function updateScene(uiState) {
  // configure data source for XYZ space
  applySpace(uiState);

  // display options such as point size, toggling buildings or roads on/off, etc.
  applyDisplayOptions(uiState);

  // update the tag filter on the XYZ tiles (if the tags have changed, this will cause new tiles to load)
  applyTags(uiState);
}

// load a new scene basemap (first creating the leaflet and tangram layers if needed)
function loadScene({ basemapScene, token }) {
  // token is used for XYZ space and basemap tiles
  // defaults to initial placeholder access token if needed, replaced after space has loaded
  basemapScene.global.xyz_access_token = token || 'Qz2TvilK6PhGZSu9K-yGkA';
  basemapScene.global.sdk_api_key = 'DpCrhQqsR2igQPEINRTfcw'; // default Nextzen API key for terrain tiles

  if (layer == null) {
    // if the Tangram layer doesn't exist yet, initialize it and load the scene for the first time
    makeLayer(basemapScene);
  }
  else {
    scene.load(basemapScene);
  }
}

// initialize Tangram leaflet layer, and load the scene for the first time
function makeLayer(scene_obj) {
  // sync popup content from svelte UI component when it changes
  appUI.on('updatePopup', () => {
    popup.setContent(document.querySelector('#ui #popupContent'));
  });

  layer = Tangram.leafletLayer({
    scene: scene_obj,
    leaflet: L,
    attribution: '<a href="https://github.com/tangrams/tangram" target="_blank">Tangram</a> | &copy; OSM contributors | <a href="https://explore.xyz.here.com/">HERE XYZ</a>',
    events: {
      hover: ({ feature, leaflet_event: { latlng }, changed }) => {
        // preview feature via hover, currently NOT synced to app UI
        if (appUI.get().featurePinned) {
          return;
        }

        if (feature && feature.source_name === '_xyzspace') {
          appUI.set({ feature, featurePinned: false });

          if (!popup.isOpen()) {
            layer.openPopup(latlng);
          }
          else {
            popup.setLatLng(latlng);
          }
        }
        else {
          layer.closePopup();
        }
      },
      click: ({ feature, leaflet_event: { latlng }, changed }) => {
        // select new feature, syncs to app UI
        if (!appUI.get().featurePinned) {
          if (feature && feature.source_name === '_xyzspace') {
            if (!popup.isOpen()) {
              layer.openPopup(latlng);
            }
            else {
              popup.setLatLng(latlng);
            }

            appUI.set({ feature, featurePinned: true });
          }
        }
        // de-select feature
        else {
          layer.closePopup();
          appUI.set({ feature: null, featurePinned: false });
        }
      }
    },
    selectionRadius: 5
  });

  // setup tooltip for hover content
  layer.bindTooltip(tooltip);
  layer.bindPopup(popup);

  // always clear pinned feature on close (e.g. maybe user manually closed with X button)
  layer.on('popupclose', e => {
    if (e.popup === popup) {
      appUI.set({ feature: null, featurePinned: false });
    }
  });

  map.on('zoom mouseout', () => {
    if (!appUI.get().feature) {
      layer.closePopup();
      appUI.set({ feature: null, featurePinned: false });
    }
  }); // close tooltip when zooming

  // setup Tangram event listeners
  layer.scene.subscribe({
    load: function ({ config }) {
      // when a new scene loads (e.g. when app loads, or a new basemap is selected),
      // update with current data source and display options
      scene_config = config;
      updateScene(appUI.get());
    },
    view_complete: function (e) {
      // when new tiles finish loading, update viewport counts for tags and feature properties
      console.log('view complete')
      queryViewport();
    }
  });

  layer.addTo(map);

  // setup screenshot event
  document.addEventListener('keydown', ({ key }) => {
    if (key == "s") { // take screenshot
      layer.scene.screenshot().then(function (screenshot) {
        FileSaver.saveAs(screenshot.blob, `invader-${(new URLSearchParams(appUI.get().queryParams))}.png`);
      });
    }
  });

  window.layer = layer; // debugging
  window.scene = layer.scene;  // debugging
}

function applySpace({ spaceId, token, hexbinInfo, basemap, displayToggles: { hexbins } = {} }) {
  if (spaceId && token) {
    // choose main space, or hexbins space
    const activeSpaceId = (hexbins > 0 && hexbinInfo.spaceId != null) ? hexbinInfo.spaceId : spaceId;
    var max_zoom = 18
    console.log('basemap',basemap)
    if (basemap == 'albers') {
        max_zoom = 2 // because tiles
        scene.view.buffer = 2
    }
        
    scene_config.sources._xyzspace = {
      type: 'GeoJSON',
      url: `https://xyz.api.here.com/hub/spaces/${activeSpaceId}/tile/web/{z}_{x}_{y}`,
      max_zoom: max_zoom,
      url_params: {
        access_token: token,
        clip: true
      }
    };
  }
}

function applyDisplayOptions(uiState) {
  for (const option in displayOptions) {
    const value = uiState.displayToggles[option];
    if (value !== undefined && displayOptions[option].apply) {
      displayOptions[option].apply(scene_config, value, uiState);
    }
  }
}

function applyTags({ spaceId, tagFilterQueryParam, hexbinInfo, displayToggles: { hexbins } = {} }) {
  // choose selected main space tags, or hexbin-specific tag
  let activeTags = tagFilterQueryParam;
  var currentZoom = scene.view.tile_zoom; // or map.getZoom() ?
  if (hexbins === 1 & Object.keys(hexbinInfo).length > 0) { // ensure hexbins info exists
    // drawing hexbins
    var hexbinZoomArray = hexbinInfo.zoomLevels
    var hexbinZoomMax = Math.max(...hexbinZoomArray)
    var hexbinZoomMin = Math.min(...hexbinZoomArray)
//     console.log(currentZoom,hexbinZoomMin,hexbinZoomMax,hexbinZoomArray)

    if (hexbinZoomArray.includes(currentZoom.toString())){ // hexbins in zoom array are strings, not numbers. maybe better to just compare min and max but there might be zooms levels between that don't have hexbins
      activeTags = 'zoom' + currentZoom + '_hexbin';
      console.log('centroid tags',activeTags)
    }
    else if (currentZoom > hexbinZoomMax) {
      // when you zoom in past hexbinZoomMax, maybe we want show the raw points? but showing hexbinZoomMax right now
//       scene_config.sources._xyzspace.url = `https://xyz.api.here.com/hub/spaces/${spaceId}/tile/web/{z}_{x}_{y}`;
//       activeTags = tagFilterQueryParam;
      activeTags = 'zoom' + hexbinZoomMax + '_hexbin';

      console.log(currentZoom + ">" + hexbinZoomMax);
    }
    else if (currentZoom < hexbinZoomMin) {
      // what should we do when we zoom out beyond the hexbinZoomMin? imagine 10 million points. show hexbinZoomMin for now
//       scene_config.sources._xyzspace.url = `https://xyz.api.here.com/hub/spaces/${spaceId}/tile/web/{z}_{x}_{y}`;
      activeTags = 'zoom' + hexbinZoomMin + '_hexbin'; // if in hexbin mode and zoomed way out, show what we've got
      console.log("beyond hexbin range, showing widest")
    }
//     activeTags = 'zoom13_hexbin';
  }
  else if (hexbins === 2 && Object.keys(hexbinInfo).length > 0) { // ensure hexbins info exists
    // drawing centroids
    var hexbinZoomArray = hexbinInfo.zoomLevels
    var hexbinZoomMax = Math.max(...hexbinZoomArray)
    var hexbinZoomMin = Math.min(...hexbinZoomArray)
    console.log(currentZoom,hexbinZoomMin,hexbinZoomMax,hexbinZoomArray)
    var overZoom = currentZoom + 1 //centroids fron one zoom level down look better

    if (hexbinZoomArray.includes(overZoom.toString())){ // hexbins in zoom array are strings, not numbers. maybe better to just compare min and max but there might be zooms levels between that don't have hexbins
      activeTags = 'zoom' + overZoom + '_centroid';
      console.log('centroid tags',activeTags)
    }
    else if (overZoom > hexbinZoomMax) {
      // when you zoom in past hexbinZoomMax, switch from centroids to raw points, need to switch back to original space (is this the best way?)
      scene_config.sources._xyzspace.url = `https://xyz.api.here.com/hub/spaces/${spaceId}/tile/web/{z}_{x}_{y}`;
      activeTags = tagFilterQueryParam;
      console.log(overZoom,">",hexbinZoomMax);
    }
    else if (overZoom < hexbinZoomMin) {
      // what should we do when we zoom out beyond the hexbinZoomMin? imagine 10 million points. show hexbinZoomMin for now
//       scene_config.sources._xyzspace.url = `https://xyz.api.here.com/hub/spaces/${spaceId}/tile/web/{z}_{x}_{y}`;
      activeTags = 'zoom' + hexbinZoomMin + '_centroid'; // if in hexbin mode and zoomed way out, show what we've got
      console.log("beyond hexbin range, showing widest")
    }
//     activeTags = 'zoom13_centroid';
  }

  scene_config.sources._xyzspace = scene_config.sources._xyzspace || {};
  scene_config.sources._xyzspace.url_params = {
    ...scene_config.sources._xyzspace.url_params,
    tags: activeTags
  };
  // remove tags param if no tags - do this after adding above, to ensure the full object path exists
  if (!activeTags) {
    delete scene_config.sources._xyzspace.url_params.tags;
  }
}

async function getStats({ spaceId, token, mapStartLocation }) {
  // Get stats endpoint
  var url = `https://xyz.api.here.com/hub/spaces/${spaceId}/statistics?access_token=${token}`;
//   const stats = await fetch(url).then(r => r.json());
//   var ok
  var stats = await fetch(url).then(r => {
//     ok = r.ok
    console.log(r)
    if(r.ok) {
      r.json()
    } else {
      console.log("error:",r.status)
      return null;
//       throw Error(`Request rejected: ${r.status}`);
    }
  }) //.catch(console.error)
//   console.log(stats)

  var bbox = null;
  var spaceSize = null;
  var spaceCount = null;
  var calcSize = null;
  var featureSize = null;
  
  if (stats){
    var bbox = stats.bbox.value
    console.log('map start location:', mapStartLocation)
    console.log('bbox',bbox)

    // check for all zero bbox
    if ((bbox[0] == 0) && (bbox[1] == 0) && (bbox[2] == 0) && (bbox[3] == 0)) {
      console.log('zeros')
      bbox = [-45, -45, 45, 45]
    }

    let fitBounds = false;
    if (mapStartLocation) {
      // if there is a map hashtag and it is outside the bbox, recenter, but if it's inside, keep that view
      if (mapStartLocation.lat < bbox[1] || mapStartLocation.lat > bbox[3] ||
          mapStartLocation.lng < bbox[0] || mapStartLocation.lng > bbox[2]) {
        console.log('map start location outside bbox');
        fitBounds = true;
      }
      else {
        map.setView([mapStartLocation.lat, mapStartLocation.lng], mapStartLocation.zoom);
      }
    }

    if (fitBounds) {
      const sw = L.latLng(bbox[1], bbox[0]);
      const ne = L.latLng(bbox[3], bbox[2]);
      const bounds = L.latLngBounds(sw, ne);
      map.fitBounds(bounds);
    }

    var spaceSize = stats.byteSize.value
    var spaceCount = stats.count.value

    var calcSize = (spaceSize/1024/1024)
    console.log(spaceSize,'KB',calcSize,featureSize)

    if (calcSize < 1000) {
      calcSize = calcSize.toFixed(1) + ' MB'
    }
    else {
      calcSize = (spaceSize/1024/1024/1024).toFixed(1) + ' GB'
    }

    var featureSize = spaceSize/spaceCount/1024 // KB per feature
    featureSize = featureSize.toFixed(1) + ' KB'
  }
  


  // Get space endpoint
  var spaceURL = `https://xyz.api.here.com/hub/spaces/${spaceId}?access_token=${token}`;
  const spaceInfo = await fetch(spaceURL).then((response) => response.json());

  // updated document title
  document.title = document.title + " / " + spaceId + " / " + spaceInfo.title

  // check for hexbins, if they exist, create a hexbin object
  const hexbinInfo = {};
  if (spaceInfo.client) {
    if (spaceInfo.client.hexbinSpaceId) {
      hexbinInfo.spaceId = spaceInfo.client.hexbinSpaceId;
      const hexbinSpaceURL = `https://xyz.api.here.com/hub/spaces/${hexbinInfo.spaceId}?access_token=${token}`;
      try {
        const hexbinSpaceInfo = await fetch(hexbinSpaceURL).then((response) => response.json());
        hexbinInfo.zoomLevels = hexbinSpaceInfo.client.zoomLevels;
        hexbinInfo.cellSizes = hexbinSpaceInfo.client.cellSizes;
      } catch (e) { } // in case hexbin space doesn't exist or fails to load
    }
  }
  
  // calculate time since data was last written to the space
  const d = new Date();
  const timeNow = d.getTime();
  const spaceUpdatedAt = new Date(spaceInfo.updatedAt);
  const secondsElapsed = (timeNow - spaceUpdatedAt) / 1000;
  const minutesElapsed = Math.round(secondsElapsed / 60)
  const hoursElapsed = Math.round(secondsElapsed / 60 / 60)
  const daysElapsed = Math.round(secondsElapsed / 60 / 60 / 24)
  const weeksElapsed = Math.round(secondsElapsed / 60 / 60 / 24 / 7)
  const monthsElapsed = Math.round(secondsElapsed / 60 / 60 / 24 / 30)
  const yearsElapsed = (daysElapsed / 365).toFixed(1)
  console.log(secondsElapsed,minutesElapsed,hoursElapsed,daysElapsed,weeksElapsed,monthsElapsed,yearsElapsed)
  let timeUnitsElapsed
  
  if (yearsElapsed > 1){
    timeUnitsElapsed = "updated " + yearsElapsed + " years ago"
  } else if (monthsElapsed > 1) {
    timeUnitsElapsed = "updated " + monthsElapsed + " months ago"
  } else if (weeksElapsed > 1) {
    timeUnitsElapsed = "updated " + weeksElapsed + " weeks ago"
  } else if (daysElapsed > 1) {
    timeUnitsElapsed = "updated " + daysElapsed + " days ago"
  } else if (hoursElapsed > 1) {
    timeUnitsElapsed = "updated " + hoursElapsed + " hours ago"
  } else if (minutesElapsed > 1) {
    timeUnitsElapsed = "updated " + minutesElapsed + " minutes ago"
  } else {
    timeUnitsElapsed = "updated " + Math.round(secondsElapsed) + " seconds ago"
  }
  console.log(timeUnitsElapsed)
  // update UI
  appUI.set({
    spaceInfo: {
      title: spaceInfo.title,
      description: spaceInfo.description,
      numFeatures: spaceCount,
      dataSize: calcSize,
      featureSize: featureSize,
      updatedAt: timeUnitsElapsed
      },

    hexbinInfo,

    // seed with top tags from stats endpoint
    uniqueTagsSeen: new Set([...appUI.get().uniqueTagsSeen, ...stats.tags.value.map(t => t.key)].filter(x => x))
  });
}

// query Tangram viewport tiles, and update UI data (tag and property counts, etc.)
async function queryViewport() {
  const features = await scene.queryFeatures({ filter: { $source: '_xyzspace' }});
  console.log("features in viewport:", features.length);
  updateViewportTags(features);
  updateViewportProperties(features);
}

function updateViewportTags(features) {  // for tags
  // grab the tags from Tangram's viewport tiles
  let tagsViewport = [];
  features.forEach(x => {
    tagsViewport.push(...x.properties['@ns:com:here:xyz'].tags)
  })

  const tagsWithCountsInViewport =
    Object.entries(
      features
        .flatMap(f => f.properties['@ns:com:here:xyz'].tags)
        .reduce((tagCounts, tag) => {
            tagCounts[tag] = tagCounts[tag] ? tagCounts[tag] + 1 : 1;
            return tagCounts;
          }, {}))
    .sort((a, b) => b[1] > a[1] ? 1 : (b[1] > a[1] ? -1 : 0));

  appUI.set({
    numFeaturesInViewport: features.length,
    tagsWithCountsInViewport
  });
}

function updateViewportProperties(features) { // for feature prop
  // first get all unique properties for features in viewport, combined with those previously seen
  const { uniqueFeaturePropsSeen } = appUI.get();
  features.forEach(feature => {
    parseNestedObject(feature.properties)
      .filter(p => !p.prop.startsWith('$')) // don't include special tangram context properties
      .filter(p => !uniqueFeaturePropsSeen.has(p.prop)) // skip features we already know about
      .forEach(p => {
        uniqueFeaturePropsSeen.set(p.prop, p.propStack);
      });
  });

  // then get feature values based on currently selected property
  const propStack = appUI.get().featurePropStack;

  if (!propStack || propStack.length === 0) {
    appUI.set({
      uniqueFeaturePropsSeen,
      featurePropCount: null,
      featurePropValueCounts: null,
      featurePropMin: null,
      featurePropMax: null,
      featurePropMedian: null,
      featurePropMean: null,
      featurePropStdDev: null,
      featurePropSigma: null,
      featurePropSigmaFloor: null,
      featurePropSigmaCeiling: null,
      featurePropHistogram: null

    });
    return;
  }

  // grab the selected feature properties from Tangram's viewport tiles
  const propsViewport = features.map(f => lookupProperty(f.properties, propStack));

  // convert to numbers to get min/max
  var vals = propsViewport
    .map(parseNumber)
    .filter(x => typeof x === 'number' && !isNaN(x) && Math.abs(x) !== Infinity);

  let min, max, mean, median, stdDev;
  let sigma = {};

  if (vals.length > 0 ) {
    min = Math.min(...vals);
    max = Math.max(...vals);

    mean = vals.reduce((a,b) => a + b, 0) / vals.length;
    if (vals.length % 2 === 0) {
      median = (vals[(vals.length / 2)] + vals[(vals.length / 2) + 1]) / 2;
    }
    else {
      median = vals[((vals.length + 1) / 2)]
    }

    var squareDiffs = vals.map(function(value){
      var diff = value - mean;
      var sqrDiff = diff * diff;
      return sqrDiff;
    });

    var avgSquareDiff = squareDiffs.reduce((a,b) => a + b, 0) / squareDiffs.length;

    stdDev = Math.sqrt(avgSquareDiff);

//     console.log('min:', min, 'max:', max, 'mean:', mean, 'median:', median, 'std dev:', stdDev);

    // calculating sigmas and ranges using standard deviations
    sigma = {
      floor: mean - stdDev,
      ceiling: mean + stdDev
    };

    sigma.count = vals.reduce((total,amount) => {
      if ((amount > sigma.floor) && (amount < sigma.ceiling)) {
        total += 1;
      }
      return total;
    }, 0);
    sigma.percent = 100 - sigma.count / vals.length
    sigma.outside = vals.length - sigma.count

//     console.log(sigma)
  } //endif

  // count up the number of each unique property value
  const propCounts = new Map(); // use map to preserve key types (e.g. avoid '[Object object]' string keys)
  for (let i = 0; i < propsViewport.length; i++) {
    const value = propsViewport[i];
    if (propCounts.get(value) == null) {
      propCounts.set(value, 0);
    }
    propCounts.set(value, propCounts.get(value) + 1);
  }

  // sort the list of properties by count
  const sortedPropCounts = Array.from(propCounts.entries()).sort((a, b) => {
    const d = b[1] - a[1];
    if (d !== 0) {
      return d;
    }

    if (a < b) {
      return -1;
    }
    else if (b < a) {
      return 1;
    }
    else {
      return 0;
    }
  });

  // update UI
  appUI.set({
    uniqueFeaturePropsSeen,
    featurePropCount: propCounts.size,
    featurePropValueCounts: sortedPropCounts,
    featurePropMin: min,
    featurePropMax: max,
    featurePropMedian: median,
    featurePropMean: mean,
    featurePropStdDev: stdDev,
    featurePropSigma: sigma.percent,
    featurePropSigmaFloor: sigma.floor,
    featurePropSigmaCeiling: sigma.ceiling
  });
}
