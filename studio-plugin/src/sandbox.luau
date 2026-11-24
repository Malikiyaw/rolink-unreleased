-- sandbox.luau — allowlist environment for safe execution.
--
-- Used by src/plugin/init.plugin.luau. Two behaviours matter here:
--
--  1. FAIL CLOSED. Applying the environment with pcall(setfenv) used to swallow
--     the failure, so on any Luau runtime without setfenv the "sandbox" ran the
--     code with FULL globals while still reporting success. run() now refuses
--     to execute when the allowlist could not be applied.
--  2. No `require`. It was in the allowlist, which let sandboxed code load any
--     ModuleScript (including ones that touch the filesystem or network) and
--     defeated the point of the allowlist. Call sites that legitimately need a
--     module must require it themselves and pass the value in.
local M = {}

M.safeEnv = {
	print = print, warn = warn, error = error,
	pairs = pairs, ipairs = ipairs, next = next, type = type, tostring = tostring, tonumber = tonumber,
	pcall = pcall, xpcall = xpcall, assert = assert, select = select, unpack = unpack,
	setmetatable = setmetatable, getmetatable = getmetatable,
	rawget = rawget, rawset = rawset, rawequal = rawequal, rawlen = rawlen,
	math = math, string = string, table = table,
	game = game, workspace = workspace, Instance = Instance, Enum = Enum, task = task,
	utf8 = utf8,
}

-- True when this runtime can actually scope a function to an environment.
function M.available(): boolean
	return type(setfenv) == "function"
end

-- Apply the allowlist to fn. Returns (ok, err) and never pretends.
function M.apply(fn: any): (boolean, string?)
	if type(fn) ~= "function" then
		return false, "sandbox: not a function"
	end
	if not M.available() then
		return false, "sandbox unavailable: setfenv is missing, so the allowlist environment cannot be applied"
	end
	local ok, err = pcall(function()
		(setfenv :: any)(fn, M.safeEnv)
	end)
	if not ok then
		return false, "sandbox unavailable: setfenv failed (" .. tostring(err):sub(1, 120) .. ")"
	end
	return true, nil
end

function M.run(code: string): (boolean, any)
	local fn, err = loadstring(code, "RoLinkSandbox")
	if not fn then
		return false, err
	end
	local applied, applyErr = M.apply(fn)
	if not applied then
		return false, applyErr
	end
	return pcall(fn)
end

return M
