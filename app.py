"""
Verkada co-termination single-purchase visualizer.

Standalone, focused Flask app: shows how ONE new license purchase merges
into an org's existing licensing, product line by product line, as a
single horizontal stacked-bar visualization. This is the minimal sibling
to ``verkada-coterm-planner`` -- no multi-step timeline, no repeatable
new-license list, just one "before" state and one "new license" purchase.

All co-termination math (``coterm.engine``) and the license SKU catalog
(``coterm.catalog`` / ``license_catalog.json``) are imported directly from
the sibling ``verkada-coterm-planner`` package rather than duplicated, so
there is exactly one source of truth for pricing and math. Only the thin
Flask glue routes below (``/api/catalog`` and ``/api/coterm/compute``) are
ported near-verbatim from that app's own ``app.py``.

No auth, no persistence beyond the request/response cycle -- state lives
in the browser and is POSTed fresh on every compute.
"""
import os
import sys
from datetime import date

from flask import Flask, jsonify, render_template, request

sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "verkada-coterm-planner"),
)
from coterm.catalog import CATALOG, FAMILIES  # noqa: E402
from coterm.engine import LicenseBatch, LicenseUnit, Organization  # noqa: E402

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/catalog")
def catalog():
    units = []
    for unit_def in CATALOG.values():
        units.append(
            {
                "key": unit_def.key,
                "label": unit_def.label,
                "family": unit_def.family,
                "unit_basis": unit_def.unit_basis,
                "devices_per_license": unit_def.devices_per_license,
                "term_options_days": list(unit_def.term_options_days),
                "skus": [
                    {
                        "term_days": s.term_days,
                        "us_price": s.us_price,
                        "term_label": s.term_label,
                    }
                    for s in unit_def.skus
                ],
            }
        )
    # Keep a stable, sensible family order; append any unexpected extras.
    families = [f for f in FAMILIES]
    for u in units:
        if u["family"] not in families:
            families.append(u["family"])

    return jsonify(families=families, units=units)


def _parse_date(value):
    if not value:
        return None
    return date.fromisoformat(value)


def _non_negative_int(value, default=0):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return n if n >= 0 else default


def _non_negative_float(value, default=1.0):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    return n if n > 0 else default


@app.route("/api/coterm/compute", methods=["POST"])
def compute():
    data = request.get_json(silent=True) or {}

    org_name = (data.get("org_name") or "").strip() or "Untitled Org"
    as_of_raw = data.get("as_of_date")
    try:
        as_of_date = _parse_date(as_of_raw) or date.today()
    except ValueError:
        return jsonify(error=f"Invalid as_of_date: {as_of_raw!r}"), 400

    raw_units = data.get("units") or []
    if not raw_units:
        return jsonify(error="At least one license column is required"), 400

    org = Organization(org_name, as_of_date)

    for raw in raw_units:
        key = (raw.get("key") or "").strip()
        label = (raw.get("label") or key or "Untitled License").strip()
        family = (raw.get("family") or "Custom").strip()
        devices_per_license = _non_negative_float(raw.get("devices_per_license"), 1.0)

        unit = LicenseUnit(
            key=key or label.lower().replace(" ", "_"),
            label=label,
            family=family,
            devices_per_license=devices_per_license,
        )

        unit.claimed_before = _non_negative_int(raw.get("claimed_before"), 0)
        unit.active_before = _non_negative_int(raw.get("active_before"), 0)

        try:
            unit.expiration_before = _parse_date(raw.get("expiration_before"))
        except ValueError:
            return (
                jsonify(
                    error=f"Invalid expiration_before for '{label}': "
                    f"{raw.get('expiration_before')!r}"
                ),
                400,
            )

        unit.new_claimed_devices = _non_negative_int(raw.get("new_claimed_devices"), 0)

        batches = []
        for b in raw.get("new_batches") or []:
            term_days = _non_negative_int(b.get("term_days"), 0)
            quantity = _non_negative_int(b.get("quantity"), 0)
            if term_days > 0 and quantity > 0:
                batches.append(LicenseBatch(term_days=term_days, quantity=quantity))
        unit.new_batches = batches

        org.register_unit(unit)

    return jsonify(org.to_dict())


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5051, debug=False)
