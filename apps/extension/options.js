import { serverBase } from './gloss.js';

const input = /** @type {HTMLInputElement} */ (document.getElementById('server'));

const { serverUrl } = await chrome.storage.sync.get('serverUrl');
input.value = typeof serverUrl === 'string' ? serverUrl : '';

// Saves as you type; a value that isn't an http(s) URL is marked and not saved.
input.addEventListener('input', () => {
  const value = input.value.trim();
  const valid = !value || serverBase(value) !== undefined;
  input.setCustomValidity(valid ? '' : 'Enter an http or https URL.');
  if (valid) void chrome.storage.sync.set({ serverUrl: value });
});
