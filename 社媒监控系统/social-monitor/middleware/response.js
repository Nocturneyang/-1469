/**
 * 统一响应格式助手函数与中间件
 * 符合 { success: true/false, data: ..., error: '...' } 规范
 */

function sendSuccess(res, data, extra = {}) {
    return res.json({
        success: true,
        data,
        ...extra
    });
}

function sendError(res, errorMsg, status = 500) {
    return res.status(status).json({
        success: false,
        error: errorMsg
    });
}

/**
 * Express 中间件，自动挂载方法到 res 上
 */
const responseHelperMiddleware = (req, res, next) => {
    res.sendSuccess = (data, extra) => sendSuccess(res, data, extra);
    res.sendError = (errorMsg, status) => sendError(res, errorMsg, status);
    next();
};

module.exports = {
    sendSuccess,
    sendError,
    responseHelperMiddleware
};
