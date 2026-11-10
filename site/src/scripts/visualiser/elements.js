// Every element the visualiser reads or updates, looked up once.
const byId = (id) => document.getElementById(id);

export const root = byId('visualiser');

export const elements = {
  samples: byId('sample-list'),
  blurb: byId('sample-blurb'),
  replay: byId('replay'),
  command: byId('command'),
  stdout: byId('stdout'),
  inputCount: byId('input-count'),
  pipeline: byId('pipeline'),
  verdict: byId('verdict'),
  lines: byId('lines'),
  showRemoved: byId('show-removed'),
  barIn: byId('bar-in'),
  barOut: byId('bar-out'),
  charsIn: byId('chars-in'),
  charsOut: byId('chars-out'),
  meterText: byId('meter-text'),
  archiveEmpty: byId('archive-empty'),
  archiveBody: byId('archive-body'),
  archiveId: byId('archive-id'),
  offset: byId('offset'),
  limit: byId('limit'),
  offsetRange: byId('offset-range'),
  recoverCommand: byId('recover-cmd'),
  sliceInfo: byId('slice-info'),
  slice: byId('slice'),
  live: byId('live'),
};

export function selectedValue(name, fallback) {
  return root.querySelector(`input[name="${name}"]:checked`)?.value ?? fallback;
}
