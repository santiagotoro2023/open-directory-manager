-- Two settings come out: the domain-wide password policy as a policy-object
-- setting, and letting people change their own password from the sign-in
-- page. Neither is what an operator reaches for — the domain's password
-- rules are set the way every other AD-compatible tool sets them, with
-- samba-tool directly, and the one setting left in this category is the
-- local machine's own, in local_password_policy, which stays exactly as it
-- is.
--
-- The fine-grained policy objects a GPO created are themselves domain state,
-- not console state, and are not touched by this: removing the GPO category
-- only stops the console from creating or editing more of them. An operator
-- who still wants one manages it with samba-tool, the same as anything else
-- this console does not have a page for today.
DROP TABLE IF EXISTS password_policy;

-- Never checked anywhere — no route ever gated on it — so a role that has it
-- has a permission that did nothing. Same as 0036 did for password.policy.write
-- when that setting moved from its own table to a GPO.
DELETE FROM rbac_role_permission WHERE permission = 'password.self_service';

-- A policy object that ever carried either setting has to lose the key, not
-- just stop being editable: the schema now refuses an unknown one, and a GPO
-- still holding it would fail to load at all rather than simply not offer it
-- any more.
UPDATE gpo
SET settings = settings - 'password_policy' - 'password_self_service'
WHERE settings ?| array['password_policy', 'password_self_service'];

-- And out of history too: a rollback to an old revision writes its settings
-- back verbatim, with no schema check on the way in — only the read after it
-- would have noticed, as a policy object that had stopped loading at all.
UPDATE gpo_revision
SET settings = settings - 'password_policy' - 'password_self_service'
WHERE settings ?| array['password_policy', 'password_self_service'];
