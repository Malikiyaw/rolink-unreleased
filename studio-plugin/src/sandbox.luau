-- sandbox.luau — allowlist env for safe execution, used by init.plugin.luau
local M = {}
M.safeEnv = {
	print = print, warn = warn, error = error,
	pairs = pairs, ipairs = ipairs, next = next, type = type, tostring = tostring, tonumber = tonumber,
	pcall = pcall, xpcall = xpcall, assert = assert, select = select, unpack = unpack,
	require = require, setmetatable = setmetatable, getmetatable = getmetatable,
	rawget = rawget, rawset = rawset, rawequal = rawequal, rawlen = rawlen,
	math = math, string = string, table = table,
	game = game, workspace = workspace, Instance = Instance, Enum = Enum, task = task,
}
function M.run(code: string)
	local fn, err = loadstring(code)
	if not fn then return false, err end
	pcall(function() setfenv(fn, M.safeEnv) end)
	return pcall(fn)
end
return M
