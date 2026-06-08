/* Provide the globals the no-build app expects (React, ReactDOM, nlp) before any
   of the global-`window` modules evaluate. Imported FIRST by entry.js so the
   classic-JSX transform's `React.createElement` and the engine's `nlp` resolve. */
import React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import nlp from 'compromise';
globalThis.React = React;
globalThis.ReactDOM = ReactDOMClient;   // exposes createRoot
globalThis.nlp = nlp;
