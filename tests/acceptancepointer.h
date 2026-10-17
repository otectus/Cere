#pragma once

#include <QElapsedTimer>
#include <QFileInfo>
#include <QDebug>
#include <wayland-client.h>
#include "wlr-virtual-pointer-client.h"
#include <cstring>
#include <linux/input-event-codes.h>

// Compositor-delivered motion/button/grab events on the sandbox's own seat.
// Never create a kernel uinput device: the user's compositor could discover it.
class AcceptancePointer {
    wl_display *display = nullptr;
    wl_registry *registry = nullptr;
    zwlr_virtual_pointer_manager_v1 *manager = nullptr;
    zwlr_virtual_pointer_v1 *pointer = nullptr;
    QElapsedTimer clock;
    bool down = false;
    static void global(void *data, wl_registry *registry, uint32_t name, const char *interface, uint32_t) {
        auto *self = static_cast<AcceptancePointer *>(data);
        if (std::strcmp(interface, zwlr_virtual_pointer_manager_v1_interface.name) == 0)
            self->manager = static_cast<zwlr_virtual_pointer_manager_v1 *>(
                wl_registry_bind(registry, name, &zwlr_virtual_pointer_manager_v1_interface, 1));
    }
    static void removed(void *, wl_registry *, uint32_t) {}
    bool submit() {
        zwlr_virtual_pointer_v1_frame(pointer);
        return wl_display_roundtrip(display) >= 0;
    }
public:
    ~AcceptancePointer() {
        if (pointer) {
            if (down && wl_display_get_error(display) == 0) button(false);
            zwlr_virtual_pointer_v1_destroy(pointer);
        }
        if (manager) zwlr_virtual_pointer_manager_v1_destroy(manager);
        if (registry) wl_registry_destroy(registry);
        if (display) { wl_display_flush(display); wl_display_disconnect(display); }
    }
    bool create() {
        if (qEnvironmentVariable("CERE_VIRTUAL_DESKTOP") != "1" ||
            QFileInfo::exists("/dev/uinput") || QFileInfo::exists("/dev/input")) return false;
        display = wl_display_connect(nullptr);
        if (!display) return false;
        registry = wl_display_get_registry(display);
        static const wl_registry_listener listener{global, removed};
        wl_registry_add_listener(registry, &listener, this);
        if (wl_display_roundtrip(display) < 0 || !manager) return false;
        pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(manager, nullptr);
        clock.start();
        if (!pointer || wl_display_roundtrip(display) < 0) return false;
        qInfo("Pointer acceptance uses the isolated Wayland compositor seat; no system input device.");
        return true;
    }
    bool button(bool pressed) {
        if (!pointer) return false;
        zwlr_virtual_pointer_v1_button(pointer, uint32_t(clock.elapsed()), BTN_LEFT,
            pressed ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED);
        down = pressed;
        return submit();
    }
    bool motion(int x, int y) {
        if (!pointer) return false;
        zwlr_virtual_pointer_v1_motion(pointer, uint32_t(clock.elapsed()), wl_fixed_from_int(x), wl_fixed_from_int(y));
        return submit();
    }
};
