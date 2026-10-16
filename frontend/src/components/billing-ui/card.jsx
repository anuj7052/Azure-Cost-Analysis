// Adapted from shadcn/ui Card (MIT, Copyright (c) 2023 shadcn).
// https://ui.shadcn.com/r/styles/new-york/card.json
// JSX and colour tokens adapted to the existing Cloudledger theme.
import { forwardRef } from 'react';

const Card = forwardRef(({ className = '', ...props }, ref) => <div ref={ref} className={`rounded-xl border border-slate-800 bg-slate-900 text-slate-100 shadow-sm ${className}`} {...props} />);
Card.displayName = 'Card';
const CardHeader = forwardRef(({ className = '', ...props }, ref) => <div ref={ref} className={`flex flex-col space-y-1.5 p-6 ${className}`} {...props} />);
CardHeader.displayName = 'CardHeader';
const CardTitle = forwardRef(({ className = '', ...props }, ref) => <h2 ref={ref} className={`font-semibold leading-none tracking-tight ${className}`} {...props} />);
CardTitle.displayName = 'CardTitle';
const CardDescription = forwardRef(({ className = '', ...props }, ref) => <p ref={ref} className={`text-sm leading-6 text-slate-400 ${className}`} {...props} />);
CardDescription.displayName = 'CardDescription';
const CardContent = forwardRef(({ className = '', ...props }, ref) => <div ref={ref} className={`p-6 pt-0 ${className}`} {...props} />);
CardContent.displayName = 'CardContent';
export { Card, CardHeader, CardTitle, CardDescription, CardContent };
