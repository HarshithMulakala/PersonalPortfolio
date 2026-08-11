/* Starfield generator. Builds three drifting layers of box shadow stars. */
(function () {
  "use strict";

  var FIELD = 2000;
  var COLORS = ["#ffffff", "#ffe9bb"];

  var layers = [
    { id: "stars1", count: 760 },
    { id: "stars2", count: 210 },
    { id: "stars3", count: 90 }
  ];

  function build(count) {
    var parts = [];
    for (var i = 0; i < count; i++) {
      var x = Math.floor(Math.random() * FIELD);
      var y = Math.floor(Math.random() * FIELD);
      var c = COLORS[Math.random() < 0.74 ? 0 : 1];
      parts.push(x + "px " + y + "px " + c);
    }
    return parts.join(",");
  }

  for (var i = 0; i < layers.length; i++) {
    var el = document.getElementById(layers[i].id);
    if (el) {
      el.style.setProperty("--stars", build(layers[i].count));
    }
  }
})();
