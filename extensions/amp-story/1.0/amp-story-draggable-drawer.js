/**
 * Copyright 2021 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  Action,
  StateProperty,
  UIType,
  getStoreService,
} from './amp-story-store-service';
import {CSS} from '../../../build/amp-story-draggable-drawer-header-1.0.css';
import {Layout} from '#core/dom/layout';
import {LocalizedStringId} from '#service/localization/strings';
import {Services} from '#service';
import {closest} from '#core/dom/query';
import {createShadowRootWithStyle} from './utils';
import {dev, devAssert} from '../../../src/log';
import {getLocalizationService} from './amp-story-localization-service';
import {htmlFor} from '#core/dom/static-template';
import {isAmpElement} from '../../../src/amp-element-helpers';
import {listen} from '../../../src/event-helper';
import {resetStyles, setImportantStyles, toggle} from '#core/dom/style';

/** @const {number} */
const TOGGLE_THRESHOLD_PX = 50;

/**
 * @enum {number}
 */
export const DrawerState = {
  CLOSED: 0,
  DRAGGING_TO_CLOSE: 1,
  DRAGGING_TO_OPEN: 2,
  OPEN: 3,
};

/**
 * Drawer's template.
 * @param {!Element} element
 * @return {!Element}
 */
const getTemplateEl = (element) => {
  return htmlFor(element)`
    <div class="i-amphtml-story-draggable-drawer">
      <div class="i-amphtml-story-draggable-drawer-container">
        <div class="i-amphtml-story-draggable-drawer-content"></div>
      </div>
    </div>`;
};

/**
 * Drawer's header template.
 * @param {!Element} element
 * @return {!Element}
 */
const getHeaderEl = (element) => {
  return htmlFor(element)`
    <div class="i-amphtml-story-draggable-drawer-header"></div>`;
};

/**
 * Abstract draggable drawer.
 * @abstract
 */
export class DraggableDrawer extends AMP.BaseElement {
  /** @override @nocollapse */
  static prerenderAllowed() {
    return false;
  }

  /** @param {!AmpElement} element */
  constructor(element) {
    super(element);

    /** @private {!Array<!Element>} AMP components within the drawer. */
    this.ampComponents_ = [];

    /** @protected {?Element} */
    this.containerEl = null;

    /** @protected {?Element} */
    this.contentEl = null;

    /** @private {number} Max value in pixels that can be dragged when opening the drawer. */
    this.dragCap_ = Infinity;

    /** @protected {?Element} */
    this.headerEl = null;

    /** @private {boolean} */
    this.ignoreCurrentSwipeYGesture_ = false;

    /** @protected {!DrawerState} */
    this.state = DrawerState.CLOSED;

    /** @protected @const {!./amp-story-store-service.AmpStoryStoreService} */
    this.storeService = getStoreService(this.win);

    /** @private {!Object} */
    this.touchEventState_ = {
      startX: 0,
      startY: 0,
      lastY: 0,
      swipingUp: null,
      isSwipeY: null,
    };

    /** @private {!Array<function()>} */
    this.touchEventUnlisteners_ = [];

    /** @private {number} Threshold in pixels above which the drawer opens itself. */
    this.openThreshold_ = Infinity;

    /**
     * Used for offsetting drag.
     * @private {?number}
     */
    this.spacerElHeight_ = null;
  }

  /** @override */
  isLayoutSupported(layout) {
    return layout === Layout.NODISPLAY;
  }

  /** @override */
  buildCallback() {
    this.element.classList.add('amp-story-draggable-drawer-root');

    const templateEl = getTemplateEl(this.element);
    const headerShadowRootEl = this.win.document.createElement('div');
    this.headerEl = getHeaderEl(this.element);

    createShadowRootWithStyle(headerShadowRootEl, this.headerEl, CSS);

    this.containerEl = dev().assertElement(
      templateEl.querySelector('.i-amphtml-story-draggable-drawer-container')
    );
    this.contentEl = dev().assertElement(
      this.containerEl.querySelector(
        '.i-amphtml-story-draggable-drawer-content'
      )
    );

    const spacerEl = this.win.document.createElement('button');
    spacerEl.classList.add('i-amphtml-story-draggable-drawer-spacer');
    spacerEl.classList.add('i-amphtml-story-system-reset');
    spacerEl.setAttribute('role', 'button');
    const localizationService = getLocalizationService(devAssert(this.element));
    if (localizationService) {
      const localizedCloseString = localizationService.getLocalizedString(
        LocalizedStringId.AMP_STORY_CLOSE_BUTTON_LABEL
      );
      spacerEl.setAttribute('aria-label', localizedCloseString);
    }
    this.containerEl.insertBefore(spacerEl, this.contentEl);
    this.contentEl.appendChild(headerShadowRootEl);

    this.element.appendChild(templateEl);
    this.element.setAttribute('aria-hidden', true);
  }

  /** @override */
  layoutCallback() {
    this.initializeListeners_();

    const walker = this.win.document.createTreeWalker(
      this.element,
      NodeFilter.SHOW_ELEMENT,
      null /** filter */,
      false /** entityReferenceExpansion */
    );
    while (walker.nextNode()) {
      const el = dev().assertElement(walker.currentNode);
      if (isAmpElement(el)) {
        this.ampComponents_.push(el);
        Services.ownersForDoc(this.element).setOwner(el, this.element);
      }
    }
    return Promise.resolve();
  }

  /**
   * @protected
   */
  initializeListeners_() {
    this.storeService.subscribe(
      StateProperty.UI_STATE,
      (uiState) => {
        this.onUIStateUpdate_(uiState);
      },
      true /** callToInitialize */
    );

    const spacerEl = dev().assertElement(
      this.element.querySelector('.i-amphtml-story-draggable-drawer-spacer')
    );

    // Handle click on spacer element to close.
    spacerEl.addEventListener('click', () => {
      this.close_();
    });

    // For displaying sticky header on mobile.
    new this.win.IntersectionObserver((e) => {
      this.headerEl.classList.toggle(
        'i-amphtml-story-draggable-drawer-header-stuck',
        !e[0].isIntersecting
      );
    }).observe(spacerEl);

    // Update spacerElHeight_ on resize for drag offset.
    new this.win.ResizeObserver((e) => {
      this.spacerElHeight_ = e[0].contentRect.height;
    }).observe(spacerEl);

    // Reset scroll position on end of close transiton.
    this.element.addEventListener('transitionend', (e) => {
      if (
        e.propertyName === 'transform' &&
        this.state_ === DrawerState.CLOSED
      ) {
        this.containerEl./*OK*/ scrollTop = 0;
      }
    });
  }

  /**
   * Reacts to UI state updates.
   * @param {!UIType} uiState
   * @protected
   */
  onUIStateUpdate_(uiState) {
    const isMobile = uiState === UIType.MOBILE;

    isMobile
      ? this.startListeningForTouchEvents_()
      : this.stopListeningForTouchEvents_();

    this.headerEl.toggleAttribute('desktop', !isMobile);
  }

  /**
   * @private
   */
  startListeningForTouchEvents_() {
    // If the element is a direct descendant of amp-story-page, authorize
    // swiping up by listening to events at the page level. Otherwise, only
    // authorize swiping down to close by listening to events at the current
    // element level.
    const parentEl = this.element.parentElement;
    const el = dev().assertElement(
      parentEl.tagName === 'AMP-STORY-PAGE' ? parentEl : this.element
    );

    this.touchEventUnlisteners_.push(
      listen(el, 'touchstart', this.onTouchStart_.bind(this), {
        capture: true,
      })
    );
    this.touchEventUnlisteners_.push(
      listen(el, 'touchmove', this.onTouchMove_.bind(this), {
        capture: true,
      })
    );
    this.touchEventUnlisteners_.push(
      listen(el, 'touchend', this.onTouchEnd_.bind(this), {
        capture: true,
      })
    );
  }

  /**
   * @private
   */
  stopListeningForTouchEvents_() {
    this.touchEventUnlisteners_.forEach((fn) => fn());
    this.touchEventUnlisteners_ = [];
  }

  /**
   * Helper to retrieve the touch coordinates from a TouchEvent.
   * @param {!Event} event
   * @return {?{x: number, y: number}}
   * @private
   */
  getClientTouchCoordinates_(event) {
    const {touches} = event;
    if (!touches || touches.length < 1) {
      return null;
    }

    const {clientX: x, clientY: y} = touches[0];
    return {x, y};
  }

  /**
   * Handles touchstart events to detect swipeY interactions.
   * @param {!Event} event
   * @private
   */
  onTouchStart_(event) {
    const coordinates = this.getClientTouchCoordinates_(event);
    if (!coordinates) {
      return;
    }

    this.touchEventState_.startX = coordinates.x;
    this.touchEventState_.startY = coordinates.y;
  }

  /**
   * Handles touchmove events to detect swipeY interactions.
   * @param {!Event} event
   * @private
   */
  onTouchMove_(event) {
    if (this.touchEventState_.isSwipeY === false) {
      return;
    }

    const coordinates = this.getClientTouchCoordinates_(event);
    if (!coordinates) {
      return;
    }

    const {x, y} = coordinates;

    this.touchEventState_.swipingUp = y < this.touchEventState_.lastY;
    this.touchEventState_.lastY = y;

    if (this.state === DrawerState.CLOSED && !this.touchEventState_.swipingUp) {
      return;
    }

    if (this.shouldStopPropagation_()) {
      event.stopPropagation();
    }

    if (this.touchEventState_.isSwipeY === null) {
      this.touchEventState_.isSwipeY =
        Math.abs(this.touchEventState_.startY - y) >
        Math.abs(this.touchEventState_.startX - x);
      if (!this.touchEventState_.isSwipeY) {
        return;
      }
    }

    this.onSwipeY_({
      event,
      data: {
        swipingUp: this.touchEventState_.swipingUp,
        deltaY: y - this.touchEventState_.startY,
        last: false,
      },
    });
  }

  /**
   * Checks for when scroll event should be stopped from propagating.
   * @return {boolean}
   * @private
   */
  shouldStopPropagation_() {
    return (
      this.state !== DrawerState.CLOSED ||
      (this.state === DrawerState.CLOSED && this.touchEventState_.swipingUp)
    );
  }

  /**
   * Handles touchend events to detect swipeY interactions.
   * @param {!Event} event
   * @private
   */
  onTouchEnd_(event) {
    if (this.touchEventState_.isSwipeY === true) {
      this.onSwipeY_({
        event,
        data: {
          swipingUp: this.touchEventState_.swipingUp,
          deltaY: this.touchEventState_.lastY - this.touchEventState_.startY,
          last: true,
        },
      });
    }

    this.touchEventState_.startX = 0;
    this.touchEventState_.startY = 0;
    this.touchEventState_.lastY = 0;
    this.touchEventState_.swipingUp = null;
    this.touchEventState_.isSwipeY = null;
  }

  /**
   * Handles swipeY events, detected by the touch events listeners.
   * @param {{event: !Event, data: !Object}} gesture
   * @private
   */
  onSwipeY_(gesture) {
    const {data} = gesture;

    if (this.ignoreCurrentSwipeYGesture_) {
      this.ignoreCurrentSwipeYGesture_ = !data.last;
      return;
    }

    const {deltaY, swipingUp} = data;

    // If the drawer is open, figure out if the user is trying to scroll the
    // content, or actually close the drawer.
    if (this.state === DrawerState.OPEN) {
      const isContentSwipe = this.isDrawerContentDescendant_(
        dev().assertElement(gesture.event.target)
      );

      // If user is swiping up, exit so the event bubbles up and maybe scrolls
      // the drawer content.
      // If user is swiping down and scrollTop is above zero, exit and let the
      // user scroll the content.
      // If user is swiping down and scrollTop is zero, don't exit and start
      // dragging/closing the drawer.
      if (
        (isContentSwipe && deltaY < 0) ||
        (isContentSwipe && deltaY > 0 && this.containerEl./*OK*/ scrollTop > 0)
      ) {
        this.ignoreCurrentSwipeYGesture_ = true;
        return;
      }
    }

    gesture.event.preventDefault();

    if (data.last === true) {
      if (this.state === DrawerState.DRAGGING_TO_CLOSE) {
        !swipingUp && deltaY > TOGGLE_THRESHOLD_PX
          ? this.close_()
          : this.open();
      }

      if (this.state === DrawerState.DRAGGING_TO_OPEN) {
        swipingUp && -deltaY > TOGGLE_THRESHOLD_PX
          ? this.open()
          : this.close_();
      }

      return;
    }

    if (
      this.state === DrawerState.DRAGGING_TO_OPEN &&
      swipingUp &&
      -deltaY > this.openThreshold_
    ) {
      this.open();
      return;
    }

    this.drag_(deltaY);
  }

  /**
   * Whether the element is a descendant of drawer-content.
   * @param {!Element} element
   * @return {boolean}
   * @private
   */
  isDrawerContentDescendant_(element) {
    return !!closest(
      element,
      (el) => {
        return el.classList.contains(
          'i-amphtml-story-draggable-drawer-content'
        );
      },
      /* opt_stopAt */ this.element
    );
  }

  /**
   * Sets a swipe threshold in pixels above which the drawer opens itself.
   * @param {number} openThreshold
   * @protected
   */
  setOpenThreshold_(openThreshold) {
    this.openThreshold_ = openThreshold;
  }

  /**
   * Sets the max value in pixels that can be dragged when opening the drawer.
   * @param {number} dragCap
   * @protected
   */
  setDragCap_(dragCap) {
    this.dragCap_ = dragCap;
  }

  /**
   * Drags the drawer on the screen upon user interaction.
   * @param {number} deltaY
   * @private
   */
  drag_(deltaY) {
    let translate;

    switch (this.state) {
      case DrawerState.CLOSED:
      case DrawerState.DRAGGING_TO_OPEN:
        if (deltaY > 0) {
          return;
        }
        this.state = DrawerState.DRAGGING_TO_OPEN;
        const drag = Math.max(deltaY, -this.dragCap_) - this.spacerElHeight_;

        translate = `translate3d(0, calc(100% + ${drag}px), 0)`;
        break;
      case DrawerState.OPEN:
      case DrawerState.DRAGGING_TO_CLOSE:
        if (deltaY < 0) {
          return;
        }
        this.state = DrawerState.DRAGGING_TO_CLOSE;
        translate = `translate3d(0, ${deltaY}px, 0)`;
        break;
    }

    this.mutateElement(() => {
      setImportantStyles(this.element, {
        transform: translate,
        transition: 'none',
        visibility: 'visible',
      });
    });
  }

  /**
   * Fully opens the drawer from its current position.
   * @param {boolean=} shouldAnimate
   */
  open(shouldAnimate = true) {
    if (this.state === DrawerState.OPEN) {
      return;
    }

    this.state = DrawerState.OPEN;

    this.storeService.dispatch(Action.TOGGLE_PAUSED, true);

    this.mutateElement(() => {
      this.element.setAttribute('aria-hidden', false);
      resetStyles(this.element, ['transform', 'transition', 'visibility']);

      if (!shouldAnimate) {
        // Resets the 'transition' property, and removes this override in the
        // next frame, after the element is positioned.
        setImportantStyles(this.element, {transition: 'initial'});
        this.mutateElement(() => resetStyles(this.element, ['transition']));
      }

      this.element.classList.add('i-amphtml-story-draggable-drawer-open');
      toggle(dev().assertElement(this.containerEl), true);
    }).then(() => {
      const owners = Services.ownersForDoc(this.element);
      owners.scheduleLayout(this.element, this.ampComponents_);
      owners.scheduleResume(this.element, this.ampComponents_);
    });
  }

  /**
   * Can be overriden for implementations using the browser history to close the
   * drawer.
   * @protected
   */
  close_() {
    this.closeInternal_();
  }

  /**
   * Fully closes the drawer from its current position.
   * @param {boolean=} shouldAnimate
   * @protected
   */
  closeInternal_(shouldAnimate = true) {
    if (this.state === DrawerState.CLOSED) {
      return;
    }

    this.state = DrawerState.CLOSED;

    this.storeService.dispatch(Action.TOGGLE_PAUSED, false);

    this.mutateElement(() => {
      this.element.setAttribute('aria-hidden', true);
      resetStyles(this.element, ['transform', 'transition']);

      if (!shouldAnimate) {
        // Resets the 'transition' property, and removes this override in the
        // next frame, after the element is positioned.
        setImportantStyles(this.element, {transition: 'initial'});
        this.mutateElement(() => resetStyles(this.element, ['transition']));
      }

      this.element.classList.remove('i-amphtml-story-draggable-drawer-open');
    }).then(() => {
      const owners = Services.ownersForDoc(this.element);
      owners.schedulePause(this.element, this.ampComponents_);
    });
  }
}
