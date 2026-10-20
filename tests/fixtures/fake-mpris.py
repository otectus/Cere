#!/usr/bin/env python3
"""A minimal MPRIS player for desktop-control tests on a private session bus.

Owns org.mpris.MediaPlayer2.<name>, answers the properties Cere reads and records
each control call it receives, one per line, in the log file. It cannot go to the
next track, so a refused command is observable too. Prints "ready" once the name
is owned. Never run it on a working desktop's session bus.
"""
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

NAME, LOG = sys.argv[1], sys.argv[2]
XML = """
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/><method name="Next"/><method name="Previous"/><method name="Stop"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="CanControl" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
  </interface>
</node>
"""
state = {"status": "Paused"}
properties = {
    "Identity": lambda: GLib.Variant("s", "Cere fixture player"),
    "PlaybackStatus": lambda: GLib.Variant("s", state["status"]),
    "CanControl": lambda: GLib.Variant("b", True),
    "CanPlay": lambda: GLib.Variant("b", True),
    "CanPause": lambda: GLib.Variant("b", True),
    "CanGoNext": lambda: GLib.Variant("b", False),
    "CanGoPrevious": lambda: GLib.Variant("b", True),
}


def call(connection, sender, path, interface, method, parameters, invocation):
    with open(LOG, "a", encoding="utf-8") as log:
        log.write(method + "\n")
    if method == "PlayPause":
        state["status"] = "Paused" if state["status"] == "Playing" else "Playing"
    elif method == "Stop":
        state["status"] = "Stopped"
    invocation.return_value(None)


def get(connection, sender, path, interface, prop):
    return properties[prop]()


def acquired(connection, name):
    for info in Gio.DBusNodeInfo.new_for_xml(XML).interfaces:
        connection.register_object("/org/mpris/MediaPlayer2", info, call, get, None)
    print("ready", flush=True)


Gio.bus_own_name(Gio.BusType.SESSION, "org.mpris.MediaPlayer2." + NAME, Gio.BusNameOwnerFlags.NONE,
                 None, acquired, lambda *_: sys.exit(1))
GLib.MainLoop().run()
