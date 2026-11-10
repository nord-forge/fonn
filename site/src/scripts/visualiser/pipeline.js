// The checks list (card 2) and the packet that travels down it.
import { elements } from './elements.js';
import { deliverText, STAGES, stageDetails, stopIndexFor } from './stages.js';
import { later } from './timers.js';

export const STEP_MS = 150;

// The check the packet rests on, so it can be re-aligned after layout changes.
let restingOn;

const SCREEN_READER_STATE = {
  pass: 'passed.',
  stop: 'stopped here.',
  skip: 'skipped.',
};

function packetOffsetFor(target) {
  const dot = target.querySelector('.stage-dot').getBoundingClientRect();
  return dot.top - elements.pipeline.getBoundingClientRect().top + dot.height / 2 - 6;
}

export function buildPipeline() {
  elements.pipeline.innerHTML = '<li class="packet" aria-hidden="true"></li>';

  // Fonts loading or the layout changing can move the dots after the packet
  // settled. Re-align it without animation whenever the list changes size.
  new ResizeObserver(() => {
    if (!restingOn) return;
    const packet = elements.pipeline.querySelector('.packet');
    packet.style.transitionDuration = '0ms';
    packet.style.transform = `translateY(${packetOffsetFor(restingOn)}px)`;
  }).observe(elements.pipeline);

  STAGES.forEach((stage, index) => {
    const item = document.createElement('li');
    item.className = 'stage';
    item.dataset.stage = stage.id;
    item.dataset.state = 'pending';
    item.style.setProperty('--i', index);
    item.innerHTML = `
      <span class="stage-dot" aria-hidden="true"></span>
      <div>
        <span class="stage-title"></span>
        <span class="stage-state sr-only"></span>
        <span class="stage-detail"></span>
      </div>`;
    item.querySelector('.stage-title').textContent = stage.title;
    elements.pipeline.append(item);
  });
}

function stateFor(index, stop) {
  if (STAGES[index].id === 'deliver') return 'pass';
  if (index < stop.index) return 'pass';
  if (index === stop.index && stop.stopped) return 'stop';
  return 'skip';
}

// The packet travels as long as the checks take to light up, then rests on
// the check where the filter stopped, or on the last one.
function movePacket(target, stop, animate) {
  const packet = elements.pipeline.querySelector('.packet');
  packet.style.transitionDuration = animate ? `${(stop.index + 1) * STEP_MS}ms` : '0ms';
  packet.style.transform = 'translateY(0)';
  packet.dataset.outcome = stop.stopped ? 'stop' : 'pass';

  restingOn = target;
  const move = () => {
    packet.style.transform = `translateY(${packetOffsetFor(target)}px)`;
  };

  if (animate) {
    void packet.offsetHeight; // Restart the transition from the top.
    later(move, 30);
  } else {
    move();
  }
}

// Updates every check for one filter result. Returns where it stopped.
export function renderPipeline({ result, preview, mode, level, command, stdout, animate }) {
  const { decision } = result;
  const stop = stopIndexFor(decision.reason);
  const proposed = preview.decision.status === 'filtered' ? preview.delivered : undefined;
  const details = stageDetails({ decision, mode, level, command, stdout, proposed });
  const items = [...elements.pipeline.querySelectorAll('.stage')];

  items.forEach((item, index) => {
    const stage = STAGES[index];
    const state = stateFor(index, stop);
    let detail = 'Not reached';
    if (stage.id === 'deliver') detail = deliverText(decision.status);
    else if (state === 'pass') detail = details[stage.id][0];
    else if (state === 'stop') detail = details[stage.id][1];

    item.dataset.state = 'pending';
    item.querySelector('.stage-detail').textContent = detail;
    item.querySelector('.stage-state').textContent = SCREEN_READER_STATE[state];

    const apply = () => { item.dataset.state = state; };
    if (animate) later(apply, 60 + index * STEP_MS);
    else apply();
  });

  movePacket(items[stop.index], stop, animate);

  return stop;
}
