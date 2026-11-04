// The tenant's side of a move-out: what the portal banner shows, and the
// "I've moved out" confirmation. The landlord's side, and the rules both share,
// are in services/portfolio/deletionGuard.service.js.

const Tenant = require("../models/Tenant");
const { completeMoveOut, tenantUnitProblem } = require("../services/portfolio/deletionGuard.service");

// GET /tenants/move-out -- whether this tenant is linked to a unit, and any
// move-out their landlord has asked for. The portal reads it to show the
// banner, or the "not linked to a unit" state in place of New request.
exports.getMoveOutStatus = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.user.id)
      .select("unit status moveOut")
      .populate({ path: "unit", select: "unitNumber propertyId archivedAt", populate: { path: "propertyId", select: "name" } })
      .lean();
    if (!tenant) return res.status(404).json({ success: false, message: "Tenant not found" });

    const unit = tenant.unit && typeof tenant.unit === "object" ? tenant.unit : null;
    return res.json({
      success: true,
      data: {
        linked: !tenantUnitProblem(tenant),
        unitLabel: unit ? `Unit ${unit.unitNumber}` : null,
        propertyName: unit?.propertyId?.name || null,
        moveOut: tenant.moveOut
          ? {
              status: tenant.moveOut.status,
              requestedAt: tenant.moveOut.requestedAt || null,
              completedAt: tenant.moveOut.completedAt || null,
            }
          : null,
      },
    });
  } catch (err) {
    console.error("[getMoveOutStatus]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// POST /tenants/move-out/confirm -- only valid once the landlord has asked.
exports.confirmMoveOut = async (req, res) => {
  try {
    const result = await completeMoveOut({ tenantId: req.user.id, by: "tenant" });
    if (result.error) {
      const { status, ...rest } = result.error;
      return res.status(status).json({ success: false, ...rest });
    }
    return res.json({ success: true, data: { moveOut: result.tenant?.moveOut || null } });
  } catch (err) {
    console.error("[confirmMoveOut]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
