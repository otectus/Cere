-- Headless acceptance session only: no autostart, host bindings, or physical input.
hl.monitor({ output = "", mode = "1920x1080@60", position = "auto", scale = 1 })
hl.config({
    general = { gaps_in = 0, gaps_out = 0, border_size = 0 },
    decoration = { rounding = 0, shadow = { enabled = false }, blur = { enabled = false } },
    animations = { enabled = false },
    misc = { disable_hyprland_logo = true, disable_splash_rendering = true },
    ecosystem = { no_update_news = true, no_donation_nag = true },
})
