import { Plugin } from '@/types/plugin';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { defaultCover } from '@libs/defaultCover';
import { fetchApi } from '@libs/fetch';
import { NovelStatus } from '@libs/novelStatus';
import { storage, localStorage } from '@libs/storage';
import dayjs from 'dayjs';

const statusKey = {
  1: NovelStatus.Ongoing,
  2: NovelStatus.Completed,
  3: NovelStatus.OnHiatus,
  4: NovelStatus.Cancelled,
};

class RanobeLibPlugin {
    id = 'RLIB'
    name = 'RanobeLib'
    site = 'https://ranobelib.me'
    apiSite = 'https://api.cdnlibs.org/api/manga/'
    version = '2.2.4'
    icon = 'src/ru/ranobelib/icon.png'
    webStorageUtilized = true
    
    // Базовые заголовки для всех запросов
    baseHeaders = {
        'Accept': 'application/json',
        'Referer': this.site,
        'Site-Id': '3',
        'client-time-zone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 YaBrowser/25.12.0.0 Safari/537.36'
    }

    // ==================== УПРАВЛЕНИЕ ТОКЕНОМ ====================

    async getUserToken() {
        // Сначала проверяем storage
        const user = storage.get('user')
        if (user?.token) {
            // Проверяем, не протух ли токен
            if (user.expires_at > Date.now() / 1000) {
                return user.token
            }
        }
        
        // Токена нет или он протух - пробуем достать из WebView
        return await this.extractTokenFromWebView()
    }

    async extractTokenFromWebView() {
        try {
            // Пробуем открыть сайт в WebView (если он еще не открыт)
            // Но лучше сначала просто выполнить JS в контексте существующего WebView
            const authData = await this.evaluateJavaScript(`
                (function() {
                    try {
                        // Ищем данные авторизации в localStorage
                        // Пробегаемся по всем ключам
                        let result = null
                        for(let i = 0; i < localStorage.length; i++) {
                            const key = localStorage.key(i)
                            try {
                                const value = localStorage.getItem(key)
                                const parsed = JSON.parse(value)
                                
                                // Ищем структуру с токеном
                                if (parsed?.token?.access_token) {
                                    result = {
                                        token: parsed.token.access_token,
                                        expires_in: parsed.token.expires_in,
                                        timestamp: parsed.token.timestamp,
                                        auth_id: parsed.auth?.id
                                    }
                                    break
                                }
                                // Альтернативный формат
                                if (parsed?.access_token) {
                                    result = {
                                        token: parsed.access_token,
                                        expires_in: parsed.expires_in || 604800,
                                        timestamp: parsed.timestamp || Date.now()/1000
                                    }
                                    break
                                }
                            } catch(e) {}
                        }
                        
                        // Если не нашли в localStorage, ищем в sessionStorage
                        if (!result) {
                            for(let i = 0; i < sessionStorage.length; i++) {
                                const key = sessionStorage.key(i)
                                try {
                                    const value = sessionStorage.getItem(key)
                                    const parsed = JSON.parse(value)
                                    if (parsed?.access_token) {
                                        result = {
                                            token: parsed.access_token,
                                            expires_in: parsed.expires_in || 3600
                                        }
                                        break
                                    }
                                } catch(e) {}
                            }
                        }
                        
                        return result
                    } catch(e) {
                        return null
                    }
                })()
            `)

            if (authData?.token) {
                // Сохраняем в storage
                const expires_at = (authData.timestamp || Date.now()/1000) + (authData.expires_in || 604800)
                storage.set('user', {
                    id: authData.auth_id,
                    token: authData.token,
                    expires_at: expires_at
                }, authData.expires_in || 604800)
                
                return authData.token
            }
            
            // Если не нашли в сторадже, пробуем вытащить из cookies
            const cookies = await this.getWebViewCookies(this.site)
            const tokenCookie = cookies.find(c => 
                c.name.includes('token') || 
                c.name.includes('access') || 
                c.name.includes('remember')
            )
            
            if (tokenCookie) {
                const expires_at = Date.now()/1000 + (7 * 24 * 60 * 60)
                storage.set('user', {
                    token: tokenCookie.value,
                    expires_at: expires_at
                }, 7 * 24 * 60 * 60)
                return tokenCookie.value
            }
            
        } catch(e) {
            console.log('Failed to extract token:', e)
        }
        return null
    }

    async getHeaders() {
        const headers = { ...this.baseHeaders }
        
        // Пытаемся получить токен
        const token = await this.getUserToken()
        if (token) {
            headers['Authorization'] = `Bearer ${token}`
        }
        
        return headers
    }

    // ==================== МЕТОД ЛОГИНА ====================

    async login() {
        // Открываем страницу логина в WebView
        await this.openWebView(`${this.site}/login`)
        
        // После закрытия пробуем извлечь токен
        const token = await this.extractTokenFromWebView()
        
        if (token) {
            // Успешно залогинились
            return {
                success: true,
                message: 'Успешный вход'
            }
        } else {
            return {
                success: false,
                message: 'Не удалось получить токен. Попробуйте войти вручную через браузер и повторить.'
            }
        }
    }

    // ==================== ОСНОВНЫЕ МЕТОДЫ ====================

    async popularNovels(pageNo, { showLatestNovels, filters }) {
        let url = this.apiSite + '?site_id[0]=3&page=' + pageNo
        url += '&sort_by=' + (showLatestNovels ? 'last_chapter_at' : filters?.sort_by?.value || 'rating_score')
        url += '&sort_type=' + (filters?.sort_type?.value || 'desc')
        
        // Добавляем остальные фильтры как в оригинале...
        if (filters?.require_chapters?.value) {
            url += '&chapters[min]=1'
        }
        
        const headers = await this.getHeaders()
        const result = await fetchApi(url, { headers }).then(res => res.json())
        
        const novels = []
        if (result.data instanceof Array) {
            result.data.forEach(novel => {
                novels.push({
                    name: novel.rus_name || novel.eng_name || novel.name,
                    cover: novel.cover?.default || defaultCover,
                    path: novel.slug_url || novel.id + '--' + novel.slug
                })
            })
        }
        return novels
    }

    async parseNovel(novelPath) {
        const headers = await this.getHeaders()
        
        const { data } = await fetchApi(
            `${this.apiSite}${novelPath}?fields[]=summary&fields[]=genres&fields[]=tags&fields[]=teams&fields[]=authors&fields[]=status_id&fields[]=artists`,
            { headers }
        ).then(res => res.json())

        const novel = {
            path: novelPath,
            name: data.rus_name || data.name,
            cover: data.cover?.default || defaultCover,
            summary: data.summary?.trim(),
            status: data.status?.id ? statusKey[data.status.id] : NovelStatus.Unknown,
            author: data.authors?.[0]?.name,
            artist: data.artists?.[0]?.name
        }

        // Жанры и теги
        const genres = [...(data.genres || []), ...(data.tags || [])]
            .map(g => g.name)
            .filter(Boolean)
        if (genres.length) {
            novel.genres = genres.join(', ')
        }

        // Получаем главы
        const chaptersData = await fetchApi(
            `${this.apiSite}${novelPath}/chapters`,
            { headers }
        ).then(res => res.json())

        if (chaptersData.data?.length) {
            // Обработка глав как в оригинале...
            novel.chapters = chaptersData.data.flatMap(chapter => 
                chapter.branches.map(({ branch_id, created_at }) => ({
                    name: `Том ${chapter.volume} Глава ${chapter.number}${chapter.name ? ' ' + chapter.name.trim() : ''}`,
                    path: `${novelPath}/${chapter.volume}/${chapter.number}/${branch_id || '0'}`,
                    releaseTime: created_at ? dayjs(created_at).format('LLL') : null,
                    chapterNumber: chapter.index
                }))
            )
        }

        return novel
    }

    async parseChapter(chapterPath) {
        const [slug, volume, number, branch_id] = chapterPath.split('/')
        
        const headers = await this.getHeaders()
        
        const url = `${this.apiSite}${slug}/chapter?` + 
                    (branch_id && branch_id !== '0' ? `branch_id=${branch_id}&` : '') +
                    `number=${number}&volume=${volume}`
        
        const result = await fetchApi(url, { headers }).then(res => res.json())
        
        if (result?.data?.content?.type == 'doc') {
            return jsonToHtml(result.data.content.content, result.data.attachments || [])
        }
        
        return result?.data?.content || ''
    }

    async searchNovels(searchTerm) {
        const url = this.apiSite + '?site_id[0]=3&q=' + searchTerm
        const headers = await this.getHeaders()
        const result = await fetchApi(url, { headers }).then(res => res.json())

        const novels = []
        if (result.data instanceof Array) {
            result.data.forEach(novel => {
                novels.push({
                    name: novel.rus_name || novel.eng_name || novel.name,
                    cover: novel.cover?.default || defaultCover,
                    path: novel.slug_url || novel.id + '--' + novel.slug
                })
            })
        }
        return novels
    }

    resolveUrl = (path, isNovel) => {
        const ui = this.user?.ui ? 'ui=' + this.user.ui : ''
        if (isNovel) return this.site + '/ru/book/' + path + (ui ? '?' + ui : '')
        
        const [slug, volume, number, branch_id] = path.split('/')
        const chapterPath = slug + '/read/v' + volume + '/c' + number + (branch_id && branch_id !== '0' ? '?bid=' + branch_id : '')
        return this.site + '/ru/' + chapterPath + (ui ? (branch_id && branch_id !== '0' ? '&' : '?') + ui : '')
    }

    // ==================== ФИЛЬТРЫ ====================
    filters = {
        sort_by: {
            label: 'Сортировка',
            value: 'rating_score',
            options: [
                { label: 'По рейтингу', value: 'rate_avg' },
                { label: 'По популярности', value: 'rating_score' },
                { label: 'По просмотрам', value: 'views' },
                { label: 'Количеству глав', value: 'chap_count' },
                { label: 'Дате обновления', value: 'last_chapter_at' },
                { label: 'Дате добавления', value: 'created_at' },
                { label: 'По названию (A-Z)', value: 'name' },
                { label: 'По названию (А-Я)', value: 'rus_name' }
            ],
            type: FilterTypes.Picker
        },
        sort_type: {
            label: 'Порядок',
            value: 'desc',
            options: [
                { label: 'По убыванию', value: 'desc' },
                { label: 'По возрастанию', value: 'asc' }
            ],
            type: FilterTypes.Picker
        },
        require_chapters: {
            label: 'Только проекты с главами',
            value: true,
            type: FilterTypes.Switch
        }
        // Остальные фильтры можно добавить по аналогии с оригиналом
    }
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

function jsonToHtml(json, images, html = '') {
    json.forEach(element => {
        switch (element.type) {
            case 'hardBreak': html += '<br>'; break
            case 'horizontalRule': html += '<hr>'; break
            case 'image':
                if (element.attrs?.images?.length) {
                    element.attrs.images.forEach(({ image }) => {
                        const file = images.find(f => f.name == image || f.id == image)
                        if (file) html += `<img src='${file.url}'>`
                    })
                }
                break
            case 'paragraph':
                html += '<p>' + (element.content ? jsonToHtml(element.content, images) : '<br>') + '</p>'
                break
            case 'orderedList':
                html += '<ol>' + (element.content ? jsonToHtml(element.content, images) : '<br>') + '</ol>'
                break
            case 'listItem':
                html += '<li>' + (element.content ? jsonToHtml(element.content, images) : '<br>') + '</li>'
                break
            case 'italic':
                html += '<i>' + (element.content ? jsonToHtml(element.content, images) : '<br>') + '</i>'
                break
            case 'bold':
                html += '<b>' + (element.content ? jsonToHtml(element.content, images) : '<br>') + '</b>'
                break
            case 'text':
                html += element.text
                break
            default:
                if (element.content) {
                    html += jsonToHtml(element.content, images)
                }
        }
    })
    return html
}

// Регистрируем плагин
window.RanobeLibPlugin = RanobeLibPlugin

// Type definitions (для совместимости)
const defaultCover = '';
const FilterTypes = { Picker: 'picker', CheckboxGroup: 'checkbox', Switch: 'switch', ExcludableCheckboxGroup: 'excludable-checkbox' };
