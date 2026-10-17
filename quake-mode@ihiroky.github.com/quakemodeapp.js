import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Shell from "gi://Shell";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { on, once } from "./util.js";

export var state = {
  INITIAL: Symbol("INITIAL"),
  READY: Symbol("READY"),
  STARTING: Symbol("STARTING"),
  RUNNING: Symbol("RUNNING"),
  DEAD: Symbol("DEAD"),
};

export var QuakeModeApp = class {
  /**
   * @param {string} app_id
   */
  constructor(app_id) {
    this.isTransition = false;
    this._transitionTimer = null;
    this.state = state.INITIAL;

    // Monitor the window is currently shown on. It is supplied by the
    // accelerator that triggered the last show, not read from settings, so a
    // single window can be shared by several accelerators with different
    // monitors.
    this._monitor = 0;

    // Accelerator slot that last showed this window (used to react to monitor
    // setting changes).
    this._slot = 0;

    /** @type {import('@girs/meta-13').Meta.Window?} */
    this.win = null;

    /** @type {import('@girs/shell-13').Shell.App?} */
    this.app = Shell.AppSystem.get_default().lookup_app(app_id);

    if (!this.app) {
      this.state = state.DEAD;
      throw new Error(`application '${app_id}' not found`);
    }

    const place = () => this.place();
    const setupAlwaysOnTop = () => this.setupAlwaysOnTop(this.alwaysOnTop);

    const extensionObject =
      /** @type import('@girs/gnome-shell/extensions/extension').Extension */ (
        Extension.lookupByURL(import.meta.url)
      );
    const settings = (this.settings = extensionObject.getSettings());

    settings.connect("changed::quake-mode-width", place);
    settings.connect("changed::quake-mode-height", place);
    settings.connect("changed::quake-mode-gap", place);
    settings.connect("changed::quake-mode-halign", place);
    settings.connect("changed::quake-mode-valign", place);
    settings.connect("changed::quake-mode-always-on-top", setupAlwaysOnTop);

    this.state = state.READY;
  }

  destroy() {
    // `destroy()` is reachable from several places (window unmanaged, a failed
    // toggle, the extension being disabled), so it must be safe to call twice:
    // disposing the settings a second time logs a critical.
    if (this.state === state.DEAD) return;

    this.state = state.DEAD;

    if (this._transitionTimer) {
      GLib.source_remove(this._transitionTimer);
      this._transitionTimer = null;
    }

    if (this.settings) {
      this.settings.run_dispose();
    }

    this.win = null;
    this.app = null;
  }

  get child() {
    if (!this.win) return null;

    /** @type {import('@girs/meta-13').Meta.WindowActor} */
    //@ts-expect-error Incorrect return type? TODO: investigate
    const child = this.win.get_compositor_private();

    if (!child) return null;

    return "clip_y" in child
      ? child
      : Object.defineProperty(child, "clip_y", {
          get() {
            return this.clip_rect.origin.y;
          },
          set(y) {
            const rect = this.clip_rect;
            this.set_clip(rect.origin.x, y, rect.size.width, rect.size.height);
          },
        });
  }

  get width() {
    return this.settings.get_int("quake-mode-width");
  }

  get height() {
    return this.settings.get_int("quake-mode-height");
  }

  get gap() {
    return this.settings.get_int("quake-mode-gap");
  }

  get focusout() {
    return this.settings.get_boolean("quake-mode-focusout");
  }

  get ainmation_time() {
    return this.settings.get_double("quake-mode-animation-time") * 1000;
  }

  get alwaysOnTop() {
    return this.settings.get_boolean("quake-mode-always-on-top");
  }

  get halign() {
    return /** @type {"left" | "center" | "right"} */ (
      this.settings.get_string("quake-mode-halign")
    );
  }

  get valign() {
    return this.settings.get_string("quake-mode-valign");
  }

  get slot() {
    return this._slot;
  }

  /**
   * @param {number} monitor
   * @returns {number}
   */
  _clampMonitor(monitor) {
    if (monitor < 0) return 0;

    const max = global.display.get_n_monitors() - 1;
    if (monitor > max) return max;

    return monitor;
  }

  /**
   * @param {number} monitor
   * @param {number} slot
   */
  toggle(monitor = 0, slot = 0) {
    // Remember where to show the window and which accelerator asked for it, so
    // a later reveal can target the monitor of whichever key was pressed.
    this._monitor = monitor;
    this._slot = slot;

    const { win } = this;

    if (this.state === state.READY)
      return this.launch()
        .then(() => this.first_place())
        .catch((e) => {
          this.destroy();
          throw e;
        });

    if (this.state !== state.RUNNING || !win) return;

    if (win.has_focus()) return this.hide();

    if (win.is_hidden()) return this.show();

    // Visible but not focused: move it onto the pressed accelerator's monitor
    // and bring it to the front (without replaying the reveal animation).
    this.place();
    Main.activateWindow(win);
  }

  /**
   * Re-targets a window that is currently shown, used when the monitor setting
   * of the accelerator that showed it changes.
   *
   * @param {number} monitor
   */
  updateMonitor(monitor) {
    this._monitor = monitor;

    if (this.state !== state.RUNNING) return;

    const { win } = this;
    if (!win || win.is_hidden()) return;

    this.place();
  }

  launch() {
    const { app } = this;
    this.state = state.STARTING;

    if (!app) return Promise.reject(new Error("no app"));

    app.open_new_window(-1);

    return new Promise((resolve, reject) => {
      const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
        sig.off();
        reject(new Error(`launch '${app.id}' timeout`));
        return GLib.SOURCE_REMOVE;
      });

      const sig = once(app, "windows-changed", () => {
        GLib.source_remove(timer);

        if (app.get_n_windows() < 1)
          return reject(`app '${app.id}' is launched but no windows`);

        this.win = app.get_windows()[0];

        this.setupAlwaysOnTop(this.alwaysOnTop);

        once(this.win, "unmanaged", () => this.destroy());

        resolve(true);
      });
    });
  }

  first_place() {
    const { win, child } = this;

    if (!win) return;

    // Without an actor there is nothing to animate; still mark the app as
    // running so later toggles are not ignored.
    if (!child) {
      this.state = state.RUNNING;
      return;
    }

    child.set_clip(0, 0, child.width, 0);
    win.stick();

    const reveal = () => {
      if (this.state !== state.STARTING) return;

      this.state = state.RUNNING;
      child.remove_clip();
      this.show();
    };

    // Drop the default map effect and wait until the window has been moved and
    // resized to its final geometry before revealing it.
    const settle = () => {
      global.window_manager.emit("kill-window-effects", child);

      // 'size-changed' may never fire if `place()` happens to leave the
      // window at its current size, so never wait forever for it.
      const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        sizeChanged.off();
        reveal();
        return GLib.SOURCE_REMOVE;
      });

      const sizeChanged = once(win, "size-changed", () => {
        GLib.source_remove(timeout);
        reveal();
      });

      this.place();
    };

    // The window is often already mapped by the time it shows up in
    // 'windows-changed'; in that case the 'map' signal has already been
    // emitted and waiting for it would leave the app stuck in STARTING.
    if (child.is_mapped?.()) {
      settle();
      return;
    }

    on(global.window_manager, "map", (sig, _wm, metaWindowChild) => {
      if (metaWindowChild !== child) return;

      sig.off();
      settle();
    });
  }

  /**
   * Latches the animation flag and clears it again after `duration`, so a
   * transition that never completes (the window can be destroyed mid animation)
   * cannot make every later toggle a no-op.
   *
   * @param {number} duration
   */
  _startTransition(duration) {
    this._endTransition();

    this.isTransition = true;
    this._transitionTimer = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      Math.round(duration) + 500,
      () => {
        this._transitionTimer = null;
        this.isTransition = false;
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _endTransition() {
    if (this._transitionTimer) {
      GLib.source_remove(this._transitionTimer);
      this._transitionTimer = null;
    }

    this.isTransition = false;
  }

  show() {
    const { child, focusout, valign } = this;

    if (this.state !== state.RUNNING) return;

    if (this.isTransition) return;

    if (!child) return;

    const parent = child.get_parent();
    if (!parent) return;

    this._startTransition(this.ainmation_time);

    parent.set_child_above_sibling(child, null);
    (child.translation_y = child.height * (valign === "top" ? -1 : 2)),
      //@ts-expect-error Missing type. TODO: contribute to @girs
      Main.wm.skipNextEffect(child);
    Main.activateWindow(child.meta_window);

    //@ts-expect-error Missing type? TODO: investigate
    child.ease({
      translation_y: 0,
      duration: this.ainmation_time,
      mode: Clutter.AnimationMode.EASE_OUT_QUART,
      onComplete: () => {
        this._endTransition();
        if (focusout)
          once(global.display, "notify::focus-window", () => this.hide());
      },
    });

    this.place();
  }

  hide() {
    const { child, valign } = this;

    if (!child) return;

    if (this.state !== state.RUNNING) return;

    if (this.isTransition) return;

    this._startTransition(this.ainmation_time);

    //@ts-expect-error
    child.ease({
      translation_y: child.height * (valign === "top" ? -1 : 2),
      duration: this.ainmation_time,
      mode: Clutter.AnimationMode.EASE_IN_QUART,
      onComplete: () => {
        //@ts-expect-error
        Main.wm.skipNextEffect(child);
        child.meta_window.minimize();
        child.translation_y = 0;
        this._endTransition();
      },
    });
  }

  place() {
    const { win, width, height, gap, halign, valign } = this;

    if (!win) return;

    const monitor = this._clampMonitor(this._monitor),
      area = win.get_work_area_for_monitor(monitor),
      w = Math.round((width * area.width) / 100),
      h = Math.round((height * area.height) / 100),
      x =
        area.x +
        Math.round(
          (area.width - w) * { left: 0, center: 0.5, right: 1 }[halign] +
            { left: gap, center: 0, right: -gap }[halign],
        ),
      y = area.y + (valign === "top" ? gap : area.height - h - gap);

    win.move_to_monitor(monitor);
    win.move_resize_frame(false, x, y, w, h);
  }

  /**
   * @param {boolean} [above]
   */
  setupAlwaysOnTop(above) {
    const { win } = this;

    if (!win) return;

    if (above) win.make_above();
    else win.unmake_above();
  }
};
