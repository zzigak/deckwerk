// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createSpeakerView } from '../src/renderer/presenter/speakerView.js';

/**
 * Speaker View's Pair phone control: present only in the shell that can
 * pair (the browser), and showing at a glance whether a phone is connected.
 */
describe('Speaker View pair phone control', () => {
  it('is absent unless the shell can pair a phone', () => {
    const host = document.createElement('div');
    const view = createSpeakerView({ host, resolveSrc: (src) => src, onCommand: () => {} });
    expect(host.querySelector('.speaker-phone')).toBeNull();
    view.setPhones(2); // harmless without the control
    view.destroy();
  });

  it('opens pairing and reports connected phones', () => {
    const host = document.createElement('div');
    const onPairPhone = vi.fn();
    const view = createSpeakerView({ host, resolveSrc: (src) => src, onCommand: () => {}, onPairPhone });
    const button = host.querySelector<HTMLButtonElement>('.speaker-phone')!;
    expect(button.textContent).toBe('Pair phone');
    // It sits with the show controls, before End show.
    expect(button.nextElementSibling?.classList.contains('speaker-end')).toBe(true);
    button.click();
    expect(onPairPhone).toHaveBeenCalledTimes(1);

    view.setPhones(1);
    expect(button.textContent).toBe('Phone connected');
    expect(button.classList.contains('connected')).toBe(true);
    view.setPhones(2);
    expect(button.textContent).toBe('2 phones connected');
    view.setPhones(0);
    expect(button.textContent).toBe('Pair phone');
    expect(button.classList.contains('connected')).toBe(false);
    view.destroy();
  });
});
