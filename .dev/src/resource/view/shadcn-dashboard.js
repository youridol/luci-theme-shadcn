"use strict";
/* Settings page for the Overview dashboard's alert thresholds.

   The dashboard's anomaly banner judges conditions in the backend
   (root/usr/share/rpcd/ucode/shadcn.uc, `buildAlerts`) against values read
   from /etc/config/shadcn-dashboard. Until now that file could only be edited
   by hand; this page is the form for it.

   Two deliberate choices:

   - Every field shows its built-in default as the placeholder, and leaving it
     empty removes the option. An absent option is not "0" — it means "use the
     default", which is what keeps a stock install working after an upgrade
     changes a default. So the page never writes a value the user did not type.

   - The defaults below are a copy of ALERT_DEFAULTS in shadcn.uc. They have to
     be: this view runs in the browser and cannot require a ucode module, and
     the banner's own rendering already reports which values are in effect, so a
     drift would be visible rather than silent. Keep the two lists equal.

   Registered by root/usr/share/luci/menu.d/luci-theme-shadcn.json. */

"require view";
"require form";
"require uci";

return view.extend({
  load: function () {
    /* uci.load() REJECTS when the config does not exist ("RPC call to uci/get
       failed with ubus code 4: 未找到资源"), and this page has to work on an
       install where /etc/config/shadcn-dashboard was never created or was
       deleted — the file is optional by design.

       Two separate failures follow from that, and both have to be handled:

       1. a rejected `load` leaves the view stuck on 「正在载入视图…」 forever,
          because view.js treats a rejected load as a page that never became
          ready — hence the catch below;
       2. `form.Map#render()` itself calls uci/get, so it throws too. Catching
          only the load is not enough: the form has no config to read. `render`
          therefore branches on what `load` resolved to.

       The package now ships the config as a conffile, so case (2) is rare, but
       deleting the file is documented as supported, so it must not brick the
       page. */
    return uci
      .load("shadcn-dashboard")
      .then(function () {
        return { present: true };
      })
      .catch(function () {
        return { present: false };
      });
  },

  render: function (state) {
    if (!state || !state.present) return this.renderMissing();

    const m = new form.Map(
      "shadcn-dashboard",
      _("Dashboard alerts"),
      _(
        "Thresholds for the anomaly banner on the Overview page. Leave a field " +
          "empty to use its default; the default is shown in grey.",
      ),
    );

    const s = m.section(form.TypedSection, "alert", _("Thresholds"));
    s.anonymous = true;
    s.addremove = false;

    /* ── Connection table ── */
    let o = s.option(
      form.Value,
      "conntrack_warn",
      _("Connection table: warning"),
    );
    o.datatype = "range(1,100)";
    o.placeholder = "80";
    o.description = _("Percent of nf_conntrack_max in use.");

    o = s.option(form.Value, "conntrack_crit", _("Connection table: critical"));
    o.datatype = "range(1,100)";
    o.placeholder = "95";
    o.description = _(
      "Percent in use above which the alert turns red instead of amber.",
    );

    /* ── Memory ── */
    o = s.option(form.Value, "mem_used", _("Memory in use"));
    o.datatype = "range(1,100)";
    o.placeholder = "90";
    o.description = _("Percent of RAM in use.");

    /* ── Temperature ── */
    o = s.option(form.Value, "temp_warn", _("Temperature: warning"));
    o.datatype = "range(1,150)";
    o.placeholder = "80";
    o.description = _("Degrees Celsius.");

    o = s.option(form.Value, "temp_crit", _("Temperature: critical"));
    o.datatype = "range(1,150)";
    o.placeholder = "90";
    o.description = _(
      "Degrees Celsius above which the alert turns red instead of amber.",
    );

    /* ── Offloaded connections ── */
    o = s.option(form.Value, "uncounted_share", _("Hardware-offloaded share"));
    o.datatype = "range(1,100)";
    o.placeholder = "50";
    o.description = _(
      "Percent of connections with no byte counters. Above this the board notes " +
        "that per-host rates cannot be measured. Informational, not a fault.",
    );

    return m.render();
  },

  /* Shown when /etc/config/shadcn-dashboard is absent.

     Rendering the form is not an option here — form.Map#render() reads the
     config and throws, which leaves the view on its loading spinner forever.
     So this state gets its own explanation and one button that asks the backend
     to write the file (UCI itself cannot create a missing config: both the
     ubus object and the CLI answer "Not found").

     After creating it we reload the whole view rather than re-rendering, because
     the form's parse chain was built against a config that did not exist. */
  renderMissing: function () {
    const self = this;
    const node = E("div", { class: "cbi-map" }, [
      E("h2", {}, _("Dashboard alerts")),
      E(
        "div",
        { class: "cbi-map-descr" },
        _(
          "The configuration file /etc/config/shadcn-dashboard does not exist. " +
            "The dashboard is using its built-in defaults, so nothing is broken " +
            "— but there is nothing to edit until the file exists.",
        ),
      ),
      E("div", { class: "cbi-page-actions" }, [
        E(
          "button",
          {
            class: "cbi-button cbi-button-apply",
            click: function (ev) {
              ev.preventDefault();
              const btn = ev.currentTarget;
              btn.disabled = true;
              btn.textContent = _("Creating…");

              return self
                .callCreateConfig()
                .then(function (res) {
                  if (res && res.ok) {
                    window.location.reload();
                    return;
                  }
                  btn.disabled = false;
                  btn.textContent = _("Create configuration");
                  window.alert(
                    _("Could not create the file: %s").format(
                      (res && res.error) || _("unknown error"),
                    ),
                  );
                })
                .catch(function (err) {
                  btn.disabled = false;
                  btn.textContent = _("Create configuration");
                  window.alert(_("Could not create the file: %s").format(err));
                });
            },
          },
          _("Create configuration"),
        ),
      ]),
    ]);

    return node;
  },

  callCreateConfig: function () {
    /* rpc.declare() returns a function that is invoked directly. Do NOT call
       `.call()` on it: that is Function.prototype.call, so it would pass its
       first argument as `this` and drop the real parameters. */
    return L.require("rpc").then(function (rpc) {
      const fn = rpc.declare({
        object: "shadcn",
        method: "createConfig",
        params: [],
      });
      return fn();
    });
  },
});
