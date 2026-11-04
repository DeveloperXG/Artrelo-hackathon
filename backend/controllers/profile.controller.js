const Tenant = require("../models/Tenant");
const Landlord = require("../models/Landlord");

exports.getUser = async (req, res, next) => {
  try {
    const { id, role } = req.user;
    let user;

    if (role === 'tenant') {
      user = await Tenant.findById(id);
    } else if (role === 'landlord') {
      user = await Landlord.findById(id);
    } else {
        // Handle other roles or default
        return res.status(400).json({ success: false, message: "Invalid user role" });
    }

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // A tenant's way to reach their property manager when something can't wait
    // for the app: the safety gate tells them the manager is being alerted, and
    // the request page says to call for anything urgent. Name and phone only --
    // what a tenant would have on their lease anyway.
    let propertyManager = null;
    if (role === "tenant" && user.landlord) {
      const landlord = await Landlord.findById(user.landlord).select("firstName lastName companyName phone").lean();
      if (landlord) {
        propertyManager = {
          name:
            landlord.companyName || [landlord.firstName, landlord.lastName].filter(Boolean).join(" ") || null,
          phone: landlord.phone || null,
        };
      }
    }

    return res.json({
      success: true,
      user,
      ...(propertyManager ? { propertyManager } : {}),
      message: "User found!",
    });

  } catch (err) {
    console.log(err);
    return res
      .status(500)
      .json({ success: false, message: "Server Error: Failed to get user" });
  }
};

exports.updateUser = async (req, res, next) => {
  try {
    const { id, role } = req.user;
    const { firstName, lastName, phone, profilePicture } = req.body; // Common updatable fields
    let user;

    const updateData = { firstName, lastName, phone, profilePicture };
    // Filter out undefined values
    Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

    if (role === 'tenant') {
      user = await Tenant.findByIdAndUpdate(id, updateData, { new: true });
    } else if (role === 'landlord') {
        user = await Landlord.findByIdAndUpdate(id, updateData, { new: true });
    } else {
         return res.status(400).json({ success: false, message: "Invalid user role" });
    }

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({
        success: true,
        message: "User updated successfully",
        user
    })
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ success: false, message: "Server Error: Failed to update user" });
  }
};
