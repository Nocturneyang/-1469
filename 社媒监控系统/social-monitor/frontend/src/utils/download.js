import { ElMessage } from 'element-plus'

function getAuthHeaders() {
  const token = localStorage.getItem('auth_token') || ''
  const ssoToken = localStorage.getItem('sso_token') || ''
  const bearer = token && token !== '__sso__' ? token : ssoToken
  return bearer ? { Authorization: `Bearer ${bearer}` } : {}
}

async function readErrorMessage(response) {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      const data = await response.json()
      return data?.error || data?.message || `下载失败 (${response.status})`
    } catch {
      return `下载失败 (${response.status})`
    }
  }
  const text = await response.text().catch(() => '')
  return text || `下载失败 (${response.status})`
}

export async function downloadAuthenticatedFile(url, filename) {
  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: getAuthHeaders()
    })

    if (!response.ok) {
      ElMessage.error(await readErrorMessage(response))
      return false
    }

    const blob = await response.blob()
    if (!blob || blob.size === 0) {
      ElMessage.warning('导出文件为空，请稍后重试或检查筛选条件')
      return false
    }

    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(objectUrl)
    return true
  } catch (err) {
    ElMessage.error(err?.message || '下载失败，请检查网络连接')
    return false
  }
}
