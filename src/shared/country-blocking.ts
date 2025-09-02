import { Request, Response, NextFunction } from "express";
import { logger } from "../logger";

const log = logger.child({ module: "country-blocking" });

interface CountryCache {
  country: string;
  timestamp: number;
}

interface IpInfoResponse {
  country: string;
  ip: string;
  [key: string]: any;
}

interface IpInfoLiteResponse {
  ip: string;
  asn: string;
  as_name: string;
  as_domain: string;
  country_code: string;
  country: string;
  continent_code: string;
  continent: string;
}

type CountryBlockingMiddleware = ((
  req: Request,
  res: Response,
  next: NextFunction
) => void) & {
  blockedCountries: string[];
  allowedCountries: string[];
  updateBlockedCountries: (countries: string[] | string) => void;
  updateAllowedCountries: (countries: string[] | string) => void;
  clearCache: () => void;
};

// In-memory cache for IP -> country mappings
const countryCache = new Map<string, CountryCache>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const API_TIMEOUT_MS = 5000; // 5 seconds

/**
 * Fetches country information for an IP address from ipinfo.io
 */
async function getCountryForIP(ip: string, token?: string): Promise<string | null> {
  try {
    // Check cache first
    const cached = countryCache.get(ip);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.country;
    }

    // Build API URL - use lite endpoint if token is provided
    const baseUrl = token 
      ? `https://api.ipinfo.io/lite/${ip}`
      : `https://ipinfo.io/${ip}/json`;
    const url = token ? `${baseUrl}?token=${token}` : baseUrl;

    // Fetch from API with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Lookup/1.0'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      log.warn({ ip, status: response.status }, "Failed to fetch country info from ipinfo.io");
      return null;
    }

    // Handle different response formats based on API endpoint
    let country: string | null = null;
    if (token) {
      // Lite API response format
      const data: IpInfoLiteResponse = await response.json();
      country = data.country_code || null;
    } else {
      // Standard API response format
      const data: IpInfoResponse = await response.json();
      country = data.country || null;
    }

    // Cache the result
    if (country) {
      countryCache.set(ip, {
        country,
        timestamp: Date.now()
      });
    }

    return country;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      log.warn({ ip }, "Timeout fetching country info from ipinfo.io");
    } else {
      log.warn({ ip, error: error.message }, "Error fetching country info from ipinfo.io");
    }
    return null;
  }
}

/**
 * Cleans up expired entries from the cache
 */
function cleanupCache(): void {
  const now = Date.now();
  for (const [ip, cached] of countryCache.entries()) {
    if (now - cached.timestamp >= CACHE_TTL_MS) {
      countryCache.delete(ip);
    }
  }
}

/**
 * Creates a country-based blocking middleware
 */
export function createCountryBlockingMiddleware(
  blockedCountries: string[] | string,
  allowedCountries: string[] | string,
  ipinfoToken?: string
): CountryBlockingMiddleware {
  let blockedList: string[] = [];
  let allowedList: string[] = [];

  const middleware: CountryBlockingMiddleware = async (req, res, next) => {
    // Skip if no filtering is configured
    if (blockedList.length === 0 && allowedList.length === 0) {
      return next();
    }

    try {
      const clientIP = req.ip;
      
      // Skip private/local IPs
      if (isPrivateIP(clientIP)) {
        return next();
      }

      const country = await getCountryForIP(clientIP, ipinfoToken);
      
      // Fail open - if we can't determine the country, allow access
      if (!country) {
        return next();
      }

      const countryUpper = country.toUpperCase();

      // If allowed countries is set, only allow those countries (whitelist mode)
      if (allowedList.length > 0) {
        if (!allowedList.includes(countryUpper)) {
          req.log.warn({ 
            ip: clientIP, 
            country, 
            allowedCountries: allowedList 
          }, "Request blocked - country not in allowed list");
          
          return res.status(403).json({ 
            error: `You are not welcomed here = ${country}`,
            blocked_country: country
          });
        }
      }
      // Otherwise, check blocked countries (blacklist mode)
      else if (blockedList.length > 0) {
        if (blockedList.includes(countryUpper)) {
          req.log.warn({ 
            ip: clientIP, 
            country, 
            blockedCountries: blockedList 
          }, "Request blocked by country filter");
          
          return res.status(403).json({ 
            error: `You are not welcomed here = ${country}`,
            blocked_country: country
          });
        }
      }

      return next();
    } catch (error: any) {
      // Fail open on any unexpected errors
      log.error({ error: error.message, ip: req.ip }, "Unexpected error in country blocking middleware");
      return next();
    }
  };

  middleware.blockedCountries = blockedList;
  middleware.allowedCountries = allowedList;
  
  middleware.updateBlockedCountries = (newCountries: string[] | string) => {
    blockedList = Array.isArray(newCountries) 
      ? newCountries.map(c => c.toUpperCase()) 
      : [newCountries.toUpperCase()];
    middleware.blockedCountries = blockedList;
    log.info({ blockedCountries: blockedList }, "Blocked countries list updated");
  };
  
  middleware.updateAllowedCountries = (newCountries: string[] | string) => {
    allowedList = Array.isArray(newCountries) 
      ? newCountries.map(c => c.toUpperCase()) 
      : [newCountries.toUpperCase()];
    middleware.allowedCountries = allowedList;
    log.info({ allowedCountries: allowedList }, "Allowed countries list updated");
  };

  middleware.clearCache = () => {
    countryCache.clear();
    log.info("Country cache cleared");
  };

  // Initialize blocked and allowed countries
  middleware.updateBlockedCountries(blockedCountries);
  middleware.updateAllowedCountries(allowedCountries);

  // Set up periodic cache cleanup
  setInterval(cleanupCache, 30 * 60 * 1000); // Every 30 minutes

  return middleware;
}

/**
 * Checks if an IP address is private/local
 */
function isPrivateIP(ip: string): boolean {
  // IPv4 private ranges
  const privateRanges = [
    /^127\./, // 127.0.0.0/8 (localhost)
    /^10\./, // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
    /^192\.168\./, // 192.168.0.0/16
    /^169\.254\./, // 169.254.0.0/16 (link-local)
  ];

  // IPv6 private ranges
  if (ip.includes(':')) {
    return ip.startsWith('::1') || // localhost
           ip.startsWith('fc') || // fc00::/7
           ip.startsWith('fd') || // fd00::/8
           ip.startsWith('fe80:'); // fe80::/10 (link-local)
  }

  return privateRanges.some(range => range.test(ip));
}

/**
 * Gets current cache statistics
 */
export function getCacheStats() {
  return {
    size: countryCache.size,
    entries: Array.from(countryCache.entries()).map(([ip, cached]) => ({
      ip,
      country: cached.country,
      age: Date.now() - cached.timestamp
    }))
  };
}
