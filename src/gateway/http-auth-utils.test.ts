import { getEventListeners, once } from "node:events";
import type { IncomingMessage } from "node:http";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  ensureProfileForEmail,
  linkEmail,
  setDisplayName,
  setUserProfileRole,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayAuthResult } from "./auth.js";
import {
  authorizeGatewayHttpRequestOrReply,
  checkGatewayHttpRequestAuth,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-auth-utils.js";
import { GatewayOperatorAccessDeniedError } from "./operator-access-policy.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const { authorize, ensureOwner } = vi.hoisted(() => ({ authorize: vi.fn(), ensureOwner: vi.fn() }));
vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  authorizeHttpGatewayConnect: authorize,
}));
vi.mock("../infra/host-account-name.js", () => ({
  resolveHostAccountName: async () => "Gateway Person",
}));
vi.mock("../state/user-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/user-profiles.js")>();
  ensureOwner.mockImplementation(actual.ensureGatewayOwnerProfile);
  return { ...actual, ensureGatewayOwnerProfile: ensureOwner };
});

const roles = {
  default: "reader",
  definitions: { reader: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] } },
} satisfies NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]>;
const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage;

async function authenticate(
  method: GatewayAuthResult["method"],
  cfg: OpenClawConfig = {},
  user?: string,
) {
  authorize.mockResolvedValueOnce({ ok: true, method, ...(user ? { user } : {}) });
  return checkGatewayHttpRequestAuth({ req, auth: { mode: "none", allowTailscale: false }, cfg });
}

function registerPersonAccessFixture() {
  const { config, registry } = createPluginRegistryFixture();
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        ...roles,
        definitions: {
          ...roles.definitions,
          reader: { ...roles.definitions.reader, accessPolicyPlugin: "person-access" },
          staff: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
        },
      },
    },
  };
  const email = "visitor@example.test";
  const person = ensureProfileForEmail(email);
  const access: { grant?: AbortController; inapplicable?: boolean } = {};
  registerVirtualTestPlugin({
    registry,
    config,
    id: "person-access",
    name: "Person access",
    register(api) {
      api.registerGatewayAccessPolicy({
        authorize({ profile }) {
          if (profile.assignedRole === "staff" || access.inapplicable) {
            return undefined;
          }
          const current = access.grant;
          if (!current || !profile.emails.includes(email)) {
            throw new Error("Current access required");
          }
          return {
            signal: current.signal,
            assertCurrent: () => current.signal.throwIfAborted(),
          };
        },
      });
    },
  });
  setActivePluginRegistry(registry.registry);
  return { cfg, email, person, access, registry: registry.registry };
}

describe("HTTP gateway owner profiles", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => resetPluginRuntimeStateForTest());

  it.each(["missing", "disabled", "failed", "unregistered", "inapplicable", "unrelated"] as const)(
    "denies a required %s policy while preserving independent staff and owner access",
    async (availability) => {
      await withOpenClawTestState({ label: "http-required-access-policy" }, async () => {
        const { cfg, email, person, access, registry } = registerPersonAccessFixture();
        access.grant = new AbortController();
        const plugin = registry.plugins.find((entry) => entry.id === "person-access");
        if (!plugin) {
          throw new Error("Expected the registered access policy owner");
        }
        if (availability === "missing") {
          registry.plugins.length = 0;
          registry.gatewayAccessPolicies.length = 0;
        } else if (availability === "disabled") {
          plugin.enabled = false;
        } else if (availability === "failed") {
          plugin.status = "error";
        } else if (availability === "unregistered") {
          registry.gatewayAccessPolicies.length = 0;
        } else if (availability === "inapplicable") {
          access.inapplicable = true;
        } else {
          cfg.gateway!.roles!.definitions.reader!.accessPolicyPlugin = "another-policy";
        }

        for (const assignment of [null, "reader", "removed-role"]) {
          setUserProfileRole(person.id, assignment);
          invalidateOperatorRolePolicy(person.id);
          expect(await authenticate("trusted-proxy", cfg, email)).toMatchObject({
            ok: false,
            authResult: { reason: "operator_access_denied" },
          });
        }
        setUserProfileRole(person.id, "staff");
        invalidateOperatorRolePolicy(person.id);
        expect(await authenticate("trusted-proxy", cfg, email)).toMatchObject({ ok: true });
        expect(await authenticate("token", cfg)).toMatchObject({ ok: true });
      });
    },
  );

  it.each(["grant ended", "email moved"])(
    "enforces registered person access without retiring independent staff authority (%s)",
    async (change) => {
      await withOpenClawTestState({ label: "http-person-access" }, async () => {
        const { cfg, email, person, access } = registerPersonAccessFixture();
        expect((await authenticate("trusted-proxy", cfg, email)).ok).toBe(false);
        access.grant = new AbortController();
        const admitted = await authenticate("trusted-proxy", cfg, email);
        if (!admitted.ok || !admitted.requestAuth.operatorAccessAuthority) {
          throw new Error("Expected admitted person access");
        }
        const captured = admitted.requestAuth.operatorAccessAuthority;
        setDisplayName(person.id, "Updated display");
        const staffEmail = "another-verified@example.test";
        linkEmail(staffEmail, person.id);
        expect(() => captured.assertCurrent()).not.toThrow();
        setUserProfileRole(person.id, "staff");
        invalidateOperatorRolePolicy(person.id);
        const staff = await authenticate("trusted-proxy", cfg, email);
        expect(staff).toMatchObject({ ok: true });
        if (!staff.ok) {
          throw new Error("Expected independent staff admission");
        }
        expect(staff.requestAuth.operatorAccessAuthority).toBeUndefined();
        if (change === "grant ended") {
          access.grant.abort(new Error("Access ended"));
        } else {
          linkEmail(email, ensureProfileForEmail("replacement@example.test").id);
        }
        expect(() => captured.assertCurrent()).toThrow(GatewayOperatorAccessDeniedError);
        expect(captured.signal.aborted).toBe(true);
        expect((await authenticate("trusted-proxy", cfg, staffEmail)).ok).toBe(true);
        access.grant = new AbortController();
        expect(() => captured.assertCurrent()).toThrow(GatewayOperatorAccessDeniedError);
        expect((await authenticate("token", cfg)).ok).toBe(true);
      });
    },
  );

  it("binds revocation to an active response and releases completed keep-alive responses", async () => {
    await withOpenClawTestState({ label: "http-response-access" }, async () => {
      const { cfg, email, access } = registerPersonAccessFixture();
      setRuntimeConfigSnapshot(cfg);
      const streaming = makeMockHttpResponse();
      const completed = makeMockHttpResponse();
      const next = makeMockHttpResponse();
      const keepAliveSocket = completed.res.req.socket;
      Object.assign(completed.res, { socket: keepAliveSocket });
      Object.assign(next.res.req, { socket: keepAliveSocket });
      Object.assign(next.res, { socket: keepAliveSocket });
      const admitResponse = async (response: ReturnType<typeof makeMockHttpResponse>) => {
        authorize.mockResolvedValueOnce({ ok: true, method: "trusted-proxy", user: email });
        const admitted = await authorizeGatewayHttpRequestOrReply({
          req: response.res.req,
          res: response.res,
          auth: { mode: "none", allowTailscale: false },
        });
        if (!admitted?.operatorAccessAuthority) {
          throw new Error("Expected admitted response access");
        }
        return admitted.operatorAccessAuthority;
      };
      try {
        access.grant = new AbortController();
        await admitResponse(streaming);
        expect(streaming.res.destroyed).toBe(false);
        access.grant.abort(new Error("Access ended"));
        expect(streaming.res.destroyed).toBe(true);

        const completedGrant = new AbortController();
        access.grant = completedGrant;
        const completedAuthority = await admitResponse(completed);
        expect(getEventListeners(completedAuthority.signal, "abort").length).toBeGreaterThan(0);
        const finished = once(completed.res, "finish");
        completed.res.end();
        await finished;
        expect(getEventListeners(completedAuthority.signal, "abort")).toEqual([]);

        access.grant = new AbortController();
        const nextAuthority = await admitResponse(next);
        completedGrant.abort(new Error("Previous invitation ended"));
        expect(completedAuthority.signal.aborted).toBe(true);
        expect(nextAuthority.signal.aborted).toBe(false);
        expect(() => nextAuthority.assertCurrent()).not.toThrow();
        expect(next.res.destroyed).toBe(false);
        expect(keepAliveSocket.destroyed).toBe(false);
      } finally {
        streaming.res.destroy();
        completed.res.destroy();
        next.res.destroy();
      }
    });
  });

  it("shares the durable owner across auth methods and preserves an edited name", async () => {
    await withOpenClawTestState({ label: "http-owner-profile" }, async () => {
      let profileId: string | undefined;
      for (const method of ["token", "password", "device-token", "none"] as const) {
        const result = await authenticate(method);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("expected authenticated request");
        }
        expect(result.requestAuth.user).toBeUndefined();
        expect(result.requestAuth.authenticatedUserProfile).toMatchObject({
          displayName: profileId ? "Saved Owner" : "Gateway Person",
        });
        const currentId = result.requestAuth.authenticatedUserProfile!.profileId;
        if (profileId) {
          expect(currentId).toBe(profileId);
        } else {
          profileId = currentId;
          setDisplayName(profileId, "Saved Owner");
        }
        expect(result.requestAuth.operatorRolePolicy).toBeUndefined();
      }
    });
  });

  it.each(["token", "password"] as const)(
    "keeps %s owner authority with configured roles",
    async (method) => {
      await withOpenClawTestState({ label: "http-owner-roles" }, async () => {
        const result = await authenticate(method, { gateway: { roles } });
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("expected authenticated request");
        }
        expect(result.requestAuth.authenticatedUserProfile).toBeDefined();
        expect(result.requestAuth.operatorRolePolicy).toBeUndefined();
        expect(result.requestAuth.trustDeclaredOperatorScopes).toBe(false);
        expect(resolveSharedSecretHttpOperatorScopes(req, result.requestAuth)).toContain(
          "operator.admin",
        );
      });
    },
  );

  it.each(["none", "device-token"] as const)(
    "keeps configured-role %s requests without identity denied",
    async (method) => {
      expect(await authenticate(method, { gateway: { roles } })).toEqual({
        ok: false,
        authResult: { ok: false, reason: "user_profile_unavailable" },
      });
      expect(ensureOwner).not.toHaveBeenCalled();
    },
  );

  it("preserves a verified user's profile and role ceiling", async () => {
    await withOpenClawTestState({ label: "http-identified-profile" }, async () => {
      const result = await authenticate(
        "trusted-proxy",
        { gateway: { roles } },
        "alice@example.test",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected authenticated request");
      }
      expect(result.requestAuth.user).toBe("alice@example.test");
      expect(result.requestAuth.authenticatedUserProfile?.displayName).toBe("alice");
      expect(result.requestAuth.operatorRolePolicy?.scopes).toEqual(["operator.read"]);
      expect(ensureOwner).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    "continues unidentified after owner storage failure (roles=%s)",
    async (configured) => {
      ensureOwner.mockImplementationOnce(() => {
        throw new Error("profile storage unavailable");
      });
      const result = await authenticate("token", configured ? { gateway: { roles } } : {});
      expect(result).toMatchObject({ ok: true, requestAuth: { authMethod: "token" } });
      if (!result.ok) {
        throw new Error("expected authenticated request");
      }
      expect(result.requestAuth.authenticatedUserProfile).toBeUndefined();
      expect(result.requestAuth.operatorRolePolicy).toBeUndefined();
    },
  );
});
