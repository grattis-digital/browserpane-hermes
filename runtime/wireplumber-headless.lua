-- This container has no host Bluetooth devices, system bus or logind seat.
-- Debian WirePlumber 0.4 otherwise exits while loading its optional logind module.
bluez_monitor.properties["with-logind"] = false
