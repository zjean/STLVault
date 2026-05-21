import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './assets/globals.css';

// Apply persisted theme before first paint to avoid a dark→light flash.
const storedTheme = localStorage.getItem('stlvault-theme');
if (storedTheme === 'light') {
  document.documentElement.setAttribute('data-theme', 'light');
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);