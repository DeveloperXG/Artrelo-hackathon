//
// If user is authenticated, then req.user should already contain their id and role.
// Check if they have the required role.
//
exports.authorize = function(requiredRole){
  return async (req, res, next) => {
     if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }
    const userRole = req.user.role;
    let authorized = false;

    if (Array.isArray(requiredRole)) {
      authorized = requiredRole.includes(userRole);
    } else {
      authorized = userRole === requiredRole;
    }

    if (!authorized) {
      return res.status(403).json({ 
        success: false,
        message: `Access denied`
      });
    }
    next();
  };
};

