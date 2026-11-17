import re,sys
def inv(path, pat):
    lines=open(path,encoding='utf-8').read().split('\n')
    out=[]
    infence=False
    for i,l in enumerate(lines):
        if l.startswith('```'): infence=not infence
        if not infence and re.match(pat,l): out.append((i,l))
    res=[]
    for k,(i,l) in enumerate(out):
        j=out[k+1][0] if k+1<len(out) else len(lines)
        res.append((i,l,sum(len(x.encode())+1 for x in lines[i:j])))
    return res
if __name__=='__main__':
    p=sys.argv[1]; pat=sys.argv[2]
    for i,l,b in inv(p,pat): print(i+1,b,l[:110])
