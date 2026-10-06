--!strict
local TITLE = "Messenger"

local function shell_quote(s: string): string
	return "'" .. string.gsub(s, "'", "'\\''") .. "'"
end

local function open_messenger(cx: WindowCx)
	for _, pane in cx.session:panes() do
		if pane.title == TITLE then
			cx.layout:focus(pane.pane)
			return
		end
	end
	local app = tern.plugin.dir .. "/dist/messenger.js"
	if not tern.fs.exists(app) then
		cx:toast("error", "Messenger is not built", "Run bun run build:tern in the Messenger repository.")
		return
	end
	local bun = tern.getenv("OMP_MESSENGER_BUN") or "bun"
	local launch = { command = shell_quote(bun) .. " " .. shell_quote(app) }
	local focused = cx.session:focused()
	local pane = if focused then cx.layout:split(focused, "right", launch) else cx.layout:new_tab(launch)
	if pane == nil then
		cx:toast("error", "Couldn't open Messenger", "The focused pane is unavailable. Try opening from another pane.")
	end
end

tern.command({
	id = "open",
	title = "Open Messenger",
	icon = "message",
	keys = { "cmd+shift+m" },
	run = open_messenger,
})
