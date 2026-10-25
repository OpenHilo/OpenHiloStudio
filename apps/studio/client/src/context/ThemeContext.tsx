import { createContext, useContext } from 'react';

interface ThemeContextValue {
  theme: 'light';
  setTheme: (t: 'light') => void;
}

const ThemeContext = createContext<ThemeContextValue>({ theme: 'light', setTheme: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeContext.Provider value={{ theme: 'light', setTheme: () => {} }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
