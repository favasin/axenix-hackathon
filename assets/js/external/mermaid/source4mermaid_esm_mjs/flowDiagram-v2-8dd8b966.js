import { p as e, f as o } from "./flowDb-c7526231.min.js";
import { f as t, g as a } from "./styles-3cfb4cad.min.js";
import { u as i } from "./mermaid-00886c59.min.js";
import "./graph-dee88f0d.min.js";
import "./index-14a831a4.min.js";
import "./layout-03086fc5.min.js";
import "./clone-a4e35854.min.js";
import "./edges-4734986e.min.js";
import "./createText-0ee50ac4.min.js";
import "./line-79437661.min.js";
import "./array-2ff2c7a6.min.js";
import "./path-428ebac9.min.js";
import "./channel-7a9b7149.min.js";
const M = {
  parser: e,
  db: o,
  renderer: t,
  styles: a,
  init: (r) => {
    r.flowchart || (r.flowchart = {}), r.flowchart.arrowMarkerAbsolute = r.arrowMarkerAbsolute, i({ flowchart: { arrowMarkerAbsolute: r.arrowMarkerAbsolute } }), t.setConf(r.flowchart), o.clear(), o.setGen("gen-2");
  }
};
export {
  M as diagram
};
