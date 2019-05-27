import AppUI from './AppUI.svelte';
import { displayOptions } from './displayOptions';

var query;
var layer;
var scene_config
var map, hash, popup;

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

map = L.map('map', {boxZoom: false});
  hash = new L.Hash(map);
  popup = L.popup();

// Leaflet needs an initial location before the map is "ready", which will block Tangram layer loading
map.setView([37.7,-122.4], 2);

map.zoomControl.setPosition('bottomright')

// Initialize App UI
const appUI = new AppUI({
  target: document.getElementById('ui')
});

// Handle UI events affecting Tangram scene
appUI.on('loadScene', ({ basemapScene }) => {
  loadScene(basemapScene);
});

appUI.on('updateScene', state => {
  if (scene_config) {
    updateScene(state);
    scene.updateConfig();
  }
});

// Load info on a new XYZ space
appUI.on('loadSpace', ({ spaceId, token }) => {
  if (mapStartLocation == null) {
    console.log('no url hash, getting bbox');
    getStats({ spaceId, token });
  } else {
    console.log('using url hash', mapStartLocation);
    getStats({ spaceId, token, mapStartLocation });
  }
});

// Handle query string updates
appUI.on('updateQueryString', ({ queryParams }) => {
  const query = new URLSearchParams(queryParams);
  const qs = `?${query.toString()}${window.location.hash}`;
  window.history.replaceState(null, null, qs);
});

// Initialize UI with query string params
appUI.setFromQueryParams(query);

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
function loadScene(scene_obj) {
  if (layer == null) {
    // if the Tangram layer doesn't exist yet, initialize it and load the scene for the first time
    makeLayer(scene_obj);
  }
  else {
    scene.load(scene_obj);
  }
}

// initialize Tangram leaflet layer, and load the scene for the first time
function makeLayer(scene_obj) {
  layer = Tangram.leafletLayer({
    scene: scene_obj,
    attribution: '<a href="https://github.com/tangrams/tangram" target="_blank">Tangram</a> | &copy; OSM contributors | <a href="https://explore.xyz.here.com/">HERE XYZ</a>',
    events: {
      hover: function({ feature }) {
        if (feature && feature.source_name === '_xyzspace') {
          // let the UI know we're hovering over a new feature
          appUI.set({ feature: feature });
        }
      }
    }
  });

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

  window.layer = layer; // debugging
  window.scene = layer.scene;  // debugging
}

function applySpace({ spaceId, token }) {
  if (spaceId && token) {
    scene_config.sources._xyzspace = {
      ...scene_config.sources._xyzspace,
      url: 'https://xyz.api.here.com/hub/spaces/' + spaceId + '/tile/web/{z}_{x}_{y}',
      url_params: {
        ...scene_config.sources._xyzspace.url_params,
        access_token: token
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

function applyTags({ tagFilterQueryParam }) {
  scene_config.sources._xyzspace.url_params = {
    ...scene_config.sources._xyzspace.url_params,
    tags: tagFilterQueryParam
  };

  // remove tags param if no tags - do this after adding above, to ensure the full object path exists
  if (!tagFilterQueryParam) {
    delete scene_config.sources._xyzspace.url_params.tags;
  }
}

async function getStats({ spaceId, token, mapStartLocation }) {
  // Get stats endpoint
  var url = `https://xyz.api.here.com/hub/spaces/${spaceId}/statistics?access_token=${token}`;
  const stats = await fetch(url).then(r => r.json());
    // console.log(stats)

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
  console.log(spaceSize,'KB',calcSize)
  if (calcSize < 1000) {
    calcSize = calcSize.toFixed(1) + ' MB'
  }
  else {
    calcSize = (spaceSize/1024/1024/1024).toFixed(1) + ' GB'
  }

  // Get space endpoint
  var spaceURL = `https://xyz.api.here.com/hub/spaces/${spaceId}?access_token=${token}`;
  const spaceInfo = await fetch(spaceURL).then((response) => response.json());

  // updated document title
  document.title = document.title + " / " + spaceId + " / " + spaceInfo.title

  // update UI
  appUI.set({
    spaceInfo: {
      title: spaceInfo.title,
      description: spaceInfo.description,
      numFeatures: spaceCount,
      dataSize: calcSize
    },

    // seed with top tags from stats endpoint
    uniqueTagsSeen: new Set([...appUI.get().uniqueTagsSeen, ...stats.tags.value.map(t => t.tag)])
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
    .sort((a, b) => b[1] - a[1]);

  appUI.set({
    numFeaturesInViewport: features.length,
    tagsWithCountsInViewport
  });
}

function updateViewportProperties(features) { // for feature prop
  const propStack = appUI.get().featurePropStack;

  if (!propStack || propStack.length === 0) {
    appUI.set({
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

  // grab the feature properties from Tangram's viewport tiles
  const propsViewport = features.map(f => {
    // property may be nested, propStack is an array of successive level of property names
    return propStack.reduce((obj, prop) => obj && obj[prop] !== undefined ? obj[prop] : null, f.properties);
  });

  // convert to numbers to get min/max
  var vals = propsViewport
    .map(parseFloat)
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

    console.log('min:', min, 'max:', max, 'mean:', mean, 'median:', median, 'std dev:', stdDev);

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

    console.log(sigma)

    // adjust for crazy outliers. 4 sigma works, but 3 sigma gives a better range where most of the data is jammed into one decile of the histogram -- maybe this can be some sort of sigma toggle?

    var sigma_filter = 4 // any values above this range get squished into the same color (and below)
    if (max > (mean + stdDev * sigma_filter)){max = mean + stdDev * sigma_filter}
    if (min < (mean - stdDev * sigma_filter)){min = mean - stdDev * sigma_filter}

    // need to clearly indicate that these 'adjusted' min and max are not the true min and max (and we also need to store the 'global' min and max...

    // here we count things for quantiles ()
    var range = max - min
    var quantile = 10
    var step = range / quantile
    var bucket = []

    // add up the things in each bucket

    for (var i = 0; i < quantile; i++) {
      bucket[i] = vals.reduce((total,amount) => {
        if ((amount > (step * i)+min) && (amount <= (step * (i+1))+ min)){
          total += 1
        }
        return total
        },1);
    }

    console.log(step,bucket)

    var quantileMax = Math.max(...bucket);
    var quantilePercent = bucket.map(x => x/quantileMax);

    console.log("quantilePercent",quantilePercent)

    var quantileChart = 'histogram: ' + quantile + ' buckets, ' + step.toFixed(1) + ' wide\n'
    quantilePercent.forEach((x,index) =>  {
      var count = bucket[index].toString()
      var width = 10
      var columns = Math.ceil(x*width)
      var spacing = ' '.repeat(width - columns)
      var row = count.padStart(6,' ') + 'x | '
      for (var i = 0; i < columns ; i++) {
        row = row + '*'
        if (i == (columns-1)){
          var suffix = spacing + ' | ' + (index*step + min).toFixed(0) + '->' + ((index+1)*step + min).toFixed(0)
          row = row + suffix + '\n'
        }
        }
      quantileChart += row
    })

    console.log(quantileChart)


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
    return d !== 0 ? d : b[0] - a[0];
  });

  // update UI
  appUI.set({
    featurePropCount: propCounts.size,
    featurePropValueCounts: sortedPropCounts,
    featurePropMin: min,
    featurePropMax: max,
    featurePropMedian: median,
    featurePropMean: mean,
    featurePropStdDev: stdDev,
    featurePropSigma: sigma.percent,
    featurePropSigmaFloor: sigma.floor,
    featurePropSigmaCeiling: sigma.ceiling,
    featurePropHistogram: quantileChart
  });
}