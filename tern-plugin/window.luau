--!strict
local TITLE = "Messenger"

local function shell_quote(s: string): string
	return "'" .. string.gsub(s, "'", "'\\''") .. "'"
end

-- One Messenger per tab: focus the one in this tab, else open a new one beside the focused pane.
-- Several can run at once; the mesh server lets one person's windows share their name.
local function open_messenger(cx: WindowCx)
	local focused = cx.session:focused()
	local panes = cx.session:panes()
	local tab: number? = nil
	for _, pane in panes do
		if pane.pane == focused then
			tab = pane.tab
		end
	end
	if tab ~= nil then
		for _, pane in panes do
			if pane.title == TITLE and pane.tab == tab then
				cx.layout:focus(pane.pane)
				return
			end
		end
	end
	local app = tern.plugin.dir .. "/dist/messenger.js"
	if not tern.fs.exists(app) then
		cx:toast("error", "Messenger is not built", "Run bun run build:tern in the Messenger repository.")
		return
	end
	local bun = tern.getenv("OMP_MESSENGER_BUN") or "bun"
	local launch = { command = shell_quote(bun) .. " " .. shell_quote(app) }
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
